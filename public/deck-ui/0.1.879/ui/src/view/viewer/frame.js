import {MapPopout} from '../map.js';
import {PageState, Skeleton, StateBlock, StatusLink} from '../page-state.js';
import {describeFailure} from '../../failure.js';
// The viewer's frame (palette SPEC.md, *Viewer*): the two-line header (back with history, title over meta, the find and date fields,
// the match stepper with real ends, Copy, Open file, the desktop panel's pop out, the source as the one filled button; under 560 px the
// tools behind More), one view of the document by kind beside its side (side.js: Details, People & things, Related; under it on a
// phone), the hint line, and the states (loading, failed with Retry and the source, the site's no-preview). Keys: SPEC's viewer table;
// the kinds take theirs first (pages, video, table, conversation), then the side's, then the frame's (R: Related).
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useReducer, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {hint as hintOf, meta, placeOf, sourceLabel, sourced} from '../../viewer.js';
import {Pages} from './pages.js';
import {Text} from './text.js';
import {Table} from './table.js';
import {Archive} from './archive.js';
import {Video} from './video.js';
import {Conversation} from './conversation.js';
import {Email} from './email.js';
import {Thing} from './thing.js';
import {Collection} from './collection.js';
import {Record} from './record.js';
import {Plan} from './plan.js';
import {collectionTarget} from '../../collection-target.js';
import {Person, Trip, Event, Day} from './card.js';
import {Photos} from './photos.js';
import {Side, peopleOf, sideEntries, sideShows} from './side.js';
import {entityHref, targetOf} from '../entity-link.js';
import {keyName, keycap, plainText} from '../keys.js';
import {Menu} from '../menu.js';
import {ownerSession} from '../../people-duplicates.js';
import {isOrg, setPersonKind} from '../../people.js';

const html = htm.bind(h);
const KINDS = {pages: Pages, text: Text, table: Table, archive: Archive, video: Video, conversation: Conversation, email: Email, thing: Thing, person: Person, trip: Trip, event: Event, calendar: Event, day: Day, collection: Collection, record: Record, photos: Photos, plan: Plan};
const FINDS = new Set(['table', 'conversation']);

export {keyName};

/** v: the viewer (viewer.js); env: {mod, platform}. */
export function Viewer({v, env = {}}) {
  const [, redraw] = useReducer(n => n + 1, 0);
  // subscribed as it commits: a change before an effect would run (an answer arriving) would be missed
  useLayoutEffect(() => v.subscribe(redraw), [v]);
  const e = v.entry;
  return e ? html`<${Frame} key=${e.seq} v=${v} e=${e} env=${env} />` : null;
}

function Frame({v, e, env}) {
  const mod = env.mod ?? 'Control';
  const root = useRef(null), kind = useRef({}), findInput = useRef(null), dateInput = useRef(null), relatedRef = useRef(null);
  const [info, setInfoState] = useState({page: 1, matches: 0, matchAt: -1, sheet: 0});
  const [railAt, setRailAt] = useState(-1);
  const [find, setFind] = useState(null); // {q} while the find field is open
  const [dateOpen, setDateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const setInfo = p => setInfoState(i => { const n = {...i, ...p}; return Object.keys(p).every(k => i[k] === n[k]) ? i : n; });
  const pane = {setInfo, kind, root};
  // Related not asked yet (after the first page): its placeholders, as while it loads
  const related = v.hasRail(e) ? v.railFor(e) ?? {busy: true} : null, details = v.hasDetails(e) ? v.detailsFor(e) : null, people = peopleOf(v.namedFor(e), related?.rail);
  const entries = sideEntries(people, related?.rail), side = sideShows({details, people, related});
  const hasRelated = !!related?.rail && entries.some(en => en.type === 'item' || en.chip?.kind === 'day');
  const ready = e.status === 'ready', K = ready ? e.kind === 'thing' && collectionTarget(e.answer) ? Collection : KINDS[e.kind] : null;
  const canFind = ready && FINDS.has(e.kind);
  // a person's or org's view, for the owner's web session: the rare correction of what it is, in More only
  const person = ready && e.kind === 'person' ? e.answer?.person : null, [owner, setOwner] = useState(false), [kindFailed, setKindFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (person?.id != null) ownerSession(v.host).then(yes => { if (active) setOwner(yes); });
    return () => { active = false; };
  }, [v.host, person?.id]);

  useLayoutEffect(() => { root.current?.focus({preventScroll: true}); }, []);
  // keys reach the viewer wherever focus is in its page (a clicked button that went away leaves it on the body), but never a field
  // of the page around it
  useLayoutEffect(() => {
    const on = ev => {
      const t = ev.target, inside = root.current?.contains(t);
      if (!inside && t !== document.body && t !== document.documentElement && t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      keys.current(ev);
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);
  useLayoutEffect(() => { if (find) findInput.current?.focus(); }, [!!find]);
  useLayoutEffect(() => { if (dateOpen) dateInput.current?.focus(); }, [dateOpen]);
  useEffect(() => { if (railAt >= entries.length) setRailAt(entries.length - 1); }, [entries.length]);

  const copyText = () => kind.current.copyText?.() ?? (e.kind === 'text' ? e.answer?.text : '');
  const step = d => kind.current.step?.(d);
  // a record: its page on the site (the record-first rule), here on a desktop (its panel has no pages)
  const openRecord = r => { if (v.host.kind === 'web') { const href = entityHref(r); if (href) globalThis.location.assign(href); } else if (targetOf(r)) v.openRecord(targetOf(r)); };
  const openRail = (en, secondary = false) => {
    if (!en) return;
    if (en.type === 'record') openRecord(en.record);
    else if (en.type === 'chip') v.chip(en.chip, {map: secondary});
    else if (en.type === 'item') secondary ? v.itemPage(en.item) : v.openRelated(en.item);
    else if (en.type === 'more') v.allOf(en.group);
  };
  const closeFind = () => { setFind(null); root.current?.focus({preventScroll: true}); };

  const keys = useRef(null);
  keys.current = onKey;
  function onKey(ev) {
    if (ev.defaultPrevented || ev.isComposing) return;
    const k = keyName(ev, mod), field = ev.target.closest?.('input, textarea, select');
    // the header's More menu keeps its keys (menu.js; Enter and Space are the items' own)
    if (ev.target.closest?.('.dv-menu')) return;
    // Details keeps its keys (its fields, its buttons' Enter and Space); Esc there leaves it for the document
    if (ev.target.closest?.('.dd')) {
      if (k === 'Esc' && !field && root.current?.contains(ev.target)) { ev.preventDefault(); root.current.focus({preventScroll: true}); }
      return;
    }
    if (field) {
      if (field === findInput.current) {
        if (k === 'Esc') { ev.preventDefault(); closeFind(); }
        else if (k === 'Enter' || k === 'Shift+Enter') { ev.preventDefault(); kind.current.findEnter?.(k === 'Shift+Enter' ? -1 : 1); }
        return;
      }
      if (field === dateInput.current) {
        if (k === 'Esc') { ev.preventDefault(); setDateOpen(false); root.current?.focus({preventScroll: true}); }
        else if (k === 'Enter') { ev.preventDefault(); kind.current.jump?.(field.value); setDateOpen(false); root.current?.focus({preventScroll: true}); }
        return;
      }
      if (kind.current.fieldKey?.(k, ev)) ev.preventDefault();
      else if (k === 'Esc' && !field.value) { ev.preventDefault(); root.current?.focus({preventScroll: true}); }
      return;
    }
    const done = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (k === 'Esc' && railAt >= 0) return done(setRailAt(-1));
    if (k === 'Esc' && find) return done(closeFind());
    if (railAt >= 0) {
      if (k === 'Enter') return done(openRail(entries[railAt]));
      if (k === 'Mod+Enter') return done(openRail(entries[railAt], true));
      if (k === 'Tab') {
        const en = entries[railAt];
        return done(en?.group ? v.allOf(en.group) : en?.type === 'chip' ? v.chip(en.chip) : openRail(en));
      }
    }
    if (entries.length && (k === 'Down' || (k === 'Up' && railAt >= 0))) return done(setRailAt(Math.max(-1, Math.min(entries.length - 1, railAt + (k === 'Down' ? 1 : -1)))));
    if (kind.current.key?.(k, ev)) return done();
    // the document's own scroll for what its kind leaves (a text, a table, an archive)
    const sc = root.current?.querySelector('.dv-main .dv-scroll');
    const by = sc && {Down: 60, Up: -60, PageDown: sc.clientHeight * 0.9, PageUp: -sc.clientHeight * 0.9, Home: -sc.scrollHeight, End: sc.scrollHeight}[k];
    if (by) { sc.scrollTop += by; return done(); }
    switch (k) {
      case 'Esc': case 'Mod+[': return done(v.back());
      case 'Mod+Enter': return done(v.source());
      case 'M': if (placeOf(e)) { done(); v.openPlace(); } return;
      // R: Related in view, its first stop selected (Enter opens it, Esc leaves)
      case 'R': if (hasRelated) { done(); relatedRef.current?.scrollIntoView({block: 'start'}); setRailAt(entries.findIndex(en => en.type === 'item' || en.chip?.kind === 'day')); } return;
      case 'N': case 'Shift+N': return done(step(k === 'N' ? 1 : -1));
      case 'Mod+F': case '/': if (canFind) { done(); setFind(f => f ?? {q: ''}); } return;
      case 'Mod+G': if (ready && e.kind === 'conversation') { done(); setDateOpen(true); } return;
      case 'Space': if (!ev.repeat && !v.embedded) v.back(); return done();
    }
  }

  const back = e.parent || !v.embedded;
  const titleTip = e.parent ? `Back to ${e.parent.title || 'the document'} (Esc)` : 'Back to the results (Esc)';
  const showFile = v.hasFile(e), showCopy = ready && v.host.caps.clipboard && (e.kind === 'text' ? !!e.answer?.text : e.kind === 'table');
  const hints = hintOf(e, {railAt, matches: info.matches, rail: hasRelated, embedded: v.embedded, web: v.host?.kind === 'web'});
  const stepper = info.matches > 0 || (find && find.q);
  // the header's tools: buttons on a wide viewer; under 560 px, behind More (the source stays a button). Map only where no Related
  // section lists what it would (a cluster's record, a person's or a day's view): a document's Related is its map
  const tools = [
    e.collection?.collection === 'clusters' || ready && ['person', 'day'].includes(e.kind)
      ? {id: 'map', label: 'Map', title: 'The map around it', run: () => v.openMap()} : null,
    canFind && !find ? {id: 'find', label: 'Find', glyph: 'find', title: `Find (${keycap('Mod+F', mod)})`, run: () => setFind({q: ''})} : null,
    showCopy ? {id: 'copy', label: 'Copy', glyph: 'copy', title: e.kind === 'table' ? `Copy the sheet (${keycap('Mod+C', mod)} copies the selected cells)` : 'Copy the text', run: () => v.copy(copyText())} : null,
    showFile ? {id: 'file', label: 'Open file', glyph: 'download', title: e.recent ? 'Open the file' : 'Download the file and open it', disabled: e.status === 'loading', run: () => v.openFile()} : null,
    v.popOut && v.host.caps?.window ? {id: 'popout', label: 'Open in a window', glyph: 'popout', cls: 'dv-popout', title: `Open in a window (${keycap('Mod+Shift+O', mod)})`, run: () => v.popOut()} : null,
    // the owner's word on what this is (bridge.personKind, over bridge's rules), then the page read again as after Undo merge
    owner && person?.id != null ? {id: 'kind', menu: true, glyph: 'person', label: kindFailed ? 'Not saved. Try again' : isOrg(person) ? 'This is a person' : 'This is an organization',
      run: () => setPersonKind(v.host, person.id, isOrg(person) ? 'person' : 'org').then(() => globalThis.location.reload(), () => setKindFailed(true))} : null,
  ].filter(Boolean);

  return html`
    <div class="dv" ref=${root} tabindex="-1" data-kind=${e.status === 'ready' ? e.kind : e.status} data-side=${side ? 'shown' : 'none'}
      aria-label=${e.title || 'Document'} role=${v.embedded ? 'region' : 'dialog'}>
      ${v.map ? html`<${MapPopout} host=${v.host} centre=${v.map} onClose=${() => v.closeMap()} />` : null}
      <header class="dv-head">
        ${back ? html`<button class=${`dk-btn icon${e.parent ? '' : ' dv-close'}`} title=${titleTip} aria-label=${titleTip} onClick=${() => v.back()}><${Glyph} name="back" /></button>` : null}
        <div class="dv-titles">
          <div class="dv-title" title=${e.title}>${e.title || (e.status === 'loading' ? '' : 'Document')}</div>
          <div class="dv-meta"><span>${meta(e, info)}</span>${v.note ? html`<span class="dv-note" role="status">${v.note}${v.noteBad ? html`<${StatusLink} host=${v.host} />` : null}</span>` : null}</div>
        </div>
        ${find || dateOpen || stepper ? html`<div class="dv-seek">
        ${find ? html`<input class="dk-field dv-find" ref=${plainText(findInput)} type="search" placeholder=${e.kind === 'table' ? 'Find in the table' : 'Find in the conversation'}
          aria-label="Find" value=${find.q} onInput=${ev => setFind({q: ev.target.value})} />` : null}
        ${dateOpen ? html`<input class="dk-field dv-date" ref=${dateInput} type="date" aria-label="Jump to a date" onChange=${ev => { kind.current.jump?.(ev.target.value); setDateOpen(false); }} />` : null}
        ${stepper ? html`<div class="dv-stepper" aria-live="polite">
          <button class="dk-btn icon text" title="Previous match (Shift+N)" aria-label="Previous match" disabled=${!(info.matchAt > 0)} onClick=${() => step(-1)}><${Glyph} name="prev" size=${16} /></button>
          <span>${info.matches ? `match ${info.matchAt + 1} of ${info.matches}` : 'no match'}</span>
          <button class="dk-btn icon text" title="Next match (N)" aria-label="Next match" disabled=${!(info.matches && info.matchAt < info.matches - 1)} onClick=${() => step(1)}><${Glyph} name="next" size=${16} /></button>
        </div>` : null}
        </div>` : null}
        <div class="dv-tools">
          ${tools.filter(t => !t.menu).map(t => html`<button key=${t.id} class=${`dk-btn dv-tool${t.glyph ? ' icon' : ''}${t.cls ? ` ${t.cls}` : ''}`} title=${t.title} aria-label=${t.glyph ? t.label : null}
            aria-pressed=${t.pressed == null ? null : t.pressed} disabled=${t.disabled} onClick=${t.run}>${t.glyph ? html`<${Glyph} name=${t.glyph} />` : t.label}</button>`)}
          ${sourced(e) && !(v.host?.kind === 'web' && sourceLabel(e) === 'Open in Deck') ? html`<button class="dk-btn main dv-source" title=${`${sourceLabel(e)} (${keycap('Mod+Enter', mod)})`} onClick=${() => v.source()}>${sourceLabel(e)} ↗</button>` : null}
          ${tools.length ? html`<${More} tools=${tools} open=${moreOpen} setOpen=${setMoreOpen} always=${tools.some(t => t.menu)} />` : null}
        </div>
      </header>
      <div class="dv-body">
        <div class="dv-main">${K ? html`<${K} v=${v} e=${e} pane=${pane} find=${find} mod=${mod} />` : html`<${State} v=${v} e=${e} />`}</div>
        ${side ? html`<${Side} v=${v} details=${details} people=${people} related=${related} entries=${entries} railAt=${railAt} mod=${mod}
          onRecord=${openRecord} relatedRef=${relatedRef} />` : null}
      </div>
      ${hints.length ? html`<footer class="dv-hint">${hints.map(([k, label]) => html`<span><kbd class="dk-key">${keycap(k, mod)}</kbd> ${label}</span>`)}</footer>` : null}
    </div>`;
}


/** Under 560 px the header's tools sit behind More. Menu-only tools keep More at every width;
 *  on wide screens its shared menu hides tools that already have header buttons. */
function More({tools, open, setOpen, always = false}) {
  const button = useRef(null);
  return html`<div class=${`dv-moreat${always ? ' always' : ''}`}>
    <button class="dk-btn icon dv-more" ref=${button} aria-label="More" title="More" aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}><${Glyph} name="more" /></button>
    ${open ? html`<${Menu} class="dv-menu" label="More" opener=${button} onClose=${() => setOpen(false)}
      items=${tools.map(t => ({key: t.id, class: t.menu ? null : 'dv-narrow', label: t.label, glyph: t.glyph ?? t.id, checked: t.pressed ?? null, disabled: t.disabled, run: t.run}))} />` : null}
  </div>`;
}

/** Loading (slow, starting up), failed, the site's no-preview, a Recent file (SPEC.md, *Viewer*: placeholders while it loads; the whole
 *  document failing a state block with Retry and the source). */
function State({v, e}) {
  // bridge starting up: its own state at once (asked again until it answers); a wait past SLOW_MS says so over the placeholder page,
  // and past the request's limit the viewer fails it (viewer.js deadline)
  if (e.status === 'loading' && e.warming) return html`<${PageState} state="warming" hasData=${false} host=${v.host} />`;
  if (e.status === 'loading') return html`<div class="dv-scroll"><div class="dv-pages">
    ${e.slow ? html`<${StateBlock} inline=${true} live=${true} line="This is taking longer than expected." />` : null}
    <div class="dv-page dv-loading" style="width:min(100%, 612px);aspect-ratio:612 / 792"><${Skeleton} /></div></div></div>`;
  if (e.status === 'failed') {
    const signedOut = e.error?.status === 401;
    return html`<${StateBlock} warn=${true} glyph="warn" host=${v.host} title=${e.recent ? 'This device: item unavailable' : 'Document unavailable'}
      line=${signedOut ? v.enrollment().message : describeFailure(e.health ? 'allos' : e.recent ? 'This device' : 'bridge', e.error).detail}
      action=${signedOut ? 'Reconnect device' : !e.recent ? 'Retry' : null} onAction=${signedOut ? () => v.reenroll() : () => v.retry()} status=${!signedOut} />`;
  }
  if (e.status === 'none') return html`<${StateBlock} glyph="document" title="No preview for this kind of file"
    line=${`Open it at its source${v.hasFile(e) ? ', or download it' : ''}.`} action=${`${sourceLabel(e)} ↗`} onAction=${() => v.source()} />`;
  if (e.kind === 'file') return html`<${StateBlock} glyph="document" title=${`No preview for ${e.title}`}
    line=${[e.recent?.path, e.recent?.size ? meta(e).replace(/^File · /, '') : null].filter(Boolean).join(' · ')}
    action=${v.hasFile(e) ? 'Open file' : null} onAction=${() => v.openFile()} />`;
  return null;
}
