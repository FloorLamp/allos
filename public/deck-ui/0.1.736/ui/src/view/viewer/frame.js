import {MapPopout} from '../map.js';
import {StatusLink} from '../page-state.js';
import {describeFailure} from '../../failure.js';
// The viewer's frame (palette SPEC.md, *Viewer*): the two-line header (back with history, title over meta, the find and date fields,
// the match stepper with real ends, Copy, Open file, Related with its count, the source as the one filled button), the document by
// kind, the Related rail, the hint line, and the states (loading, failed with Retry and the source, the site's no-preview). Keys:
// SPEC's viewer table; the kinds take theirs first (pages, video, table, conversation), then the rail's, then the frame's.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useReducer, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {hint as hintOf, meta, sourceLabel} from '../../viewer.js';
import {Pages} from './pages.js';
import {Text} from './text.js';
import {Table} from './table.js';
import {Archive} from './archive.js';
import {Video} from './video.js';
import {Conversation} from './conversation.js';
import {Email} from './email.js';
import {Thing} from './thing.js';
import {Collection} from './collection.js';
import {collectionTarget} from '../../collection-target.js';
import {Person, Trip, Event, Day} from './card.js';
import {Rail, railEntries} from './rail.js';
import {Details} from './details.js';
import {keyName, keycap, plainText} from '../keys.js';

const html = htm.bind(h);
const KINDS = {pages: Pages, text: Text, table: Table, archive: Archive, video: Video, conversation: Conversation, email: Email, thing: Thing, person: Person, trip: Trip, event: Event, day: Day, collection: Collection};
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
  const root = useRef(null), kind = useRef({}), findInput = useRef(null), dateInput = useRef(null);
  const [info, setInfoState] = useState({page: 1, matches: 0, matchAt: -1, sheet: 0});
  const [railAt, setRailAt] = useState(-1);
  const [find, setFind] = useState(null); // {q} while the find field is open
  const [dateOpen, setDateOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const setInfo = p => setInfoState(i => { const n = {...i, ...p}; return Object.keys(p).every(k => i[k] === n[k]) ? i : n; });
  const pane = {setInfo, kind, root};
  const related = v.railFor(e), hasRail = v.hasRail(e), hasDetails = v.hasDetails(e), detailsShown = hasDetails && v.detailsShown;
  const railShown = hasRail && v.railShown && !detailsShown;
  const entries = railShown ? railEntries(related?.rail) : [];
  const count = related?.rail ? related.rail.groups.reduce((n, g) => n + g.count, 0) : 0;
  const ready = e.status === 'ready', K = ready ? e.kind === 'thing' && collectionTarget(e.answer) ? Collection : KINDS[e.kind] : null;
  const canFind = ready && FINDS.has(e.kind);

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
  const openRail = (en, secondary = false) => {
    if (!en) return;
    if (en.type === 'chip') v.chip(en.chip, {map: secondary});
    else if (en.type === 'item') secondary ? v.itemPage(en.item) : v.openRelated(en.item);
    else if (en.type === 'more') v.allOf(en.group);
  };
  const closeFind = () => { setFind(null); root.current?.focus({preventScroll: true}); };

  const keys = useRef(null);
  keys.current = onKey;
  function onKey(ev) {
    if (ev.defaultPrevented || ev.isComposing) return;
    const k = keyName(ev, mod), field = ev.target.closest?.('input, textarea, select');
    // the Details pane keeps its keys (its fields, its buttons' Enter and Space); Esc there leaves it for the document
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
      case 'R': if (hasRail) { done(); if (detailsShown) v.toggleDetails(); if (!v.railShown || !detailsShown) v.toggleRail(); setRailAt(-1); } return;
      case 'I': if (hasDetails) { done(); v.toggleDetails(); setRailAt(-1); } return;
      // Enter: Details, as I (a held Enter's repeats never toggle it; a focused button keeps its own Enter)
      case 'Enter': if (hasDetails && !ev.repeat && !ev.target.closest?.('button, a')) { done(); v.toggleDetails(); setRailAt(-1); } return;
      case 'N': case 'Shift+N': return done(step(k === 'N' ? 1 : -1));
      case 'Mod+F': case '/': if (canFind) { done(); setFind(f => f ?? {q: ''}); } return;
      case 'Mod+G': if (ready && e.kind === 'conversation') { done(); setDateOpen(true); } return;
      case 'Space': if (!ev.repeat && !v.embedded) v.back(); return done();
    }
  }

  const back = e.parent || !v.embedded;
  const titleTip = e.parent ? `Back to ${e.parent.title || 'the document'} (Esc)` : 'Back to the results (Esc)';
  const showFile = v.hasFile(e), showCopy = ready && v.host.caps.clipboard && (e.kind === 'text' ? !!e.answer?.text : e.kind === 'table');
  const hints = hintOf(e, {railAt, matches: info.matches, rail: hasRail, embedded: v.embedded, details: hasDetails, detailsShown});
  const stepper = info.matches > 0 || (find && find.q);

  return html`
    <div class="dv" ref=${root} tabindex="-1" data-kind=${e.status === 'ready' ? e.kind : e.status} data-rail=${railShown ? 'shown' : 'hidden'}
      aria-label=${e.title || 'Document'} role=${v.embedded ? 'region' : 'dialog'}>
      ${v.map ? html`<${MapPopout} host=${v.host} centre=${v.map} onClose=${() => v.closeMap()} />` : null}
      <header class="dv-head">
        ${back ? html`<button class="dk-btn icon" title=${titleTip} aria-label=${titleTip} onClick=${() => v.back()}><${Glyph} name="back" /></button>` : null}
        <div class="dv-titles">
          <div class="dv-title" title=${e.title}>${e.title || (e.status === 'loading' ? '' : 'Document')}</div>
          <div class="dv-meta"><span>${meta(e, info)}</span>${v.note ? html`<span class="dv-note" role="status">${v.note}${v.noteBad ? html`<${StatusLink} host=${v.host} />` : null}</span>` : null}</div>
        </div>
        ${find ? html`<input class="dk-field dv-find" ref=${plainText(findInput)} type="search" placeholder=${e.kind === 'table' ? 'Find in the table' : 'Find in the conversation'}
          aria-label="Find" value=${find.q} onInput=${ev => setFind({q: ev.target.value})} />` : null}
        ${dateOpen ? html`<input class="dk-field dv-date" ref=${dateInput} type="date" aria-label="Jump to a date" onChange=${ev => { kind.current.jump?.(ev.target.value); setDateOpen(false); }} />` : null}
        ${stepper ? html`<div class="dv-stepper" aria-live="polite">
          <button class="dk-btn icon" title="Previous match (Shift+N)" aria-label="Previous match" disabled=${!(info.matchAt > 0)} onClick=${() => step(-1)}><${Glyph} name="prev" size=${16} /></button>
          <span>${info.matches ? `match ${info.matchAt + 1} of ${info.matches}` : 'no match'}</span>
          <button class="dk-btn icon" title="Next match (N)" aria-label="Next match" disabled=${!(info.matches && info.matchAt < info.matches - 1)} onClick=${() => step(1)}><${Glyph} name="next" size=${16} /></button>
        </div>` : null}
        <div class="dv-tools">
          ${e.collection?.collection === 'clusters' || e.id && !e.recent ? html`<button class="dk-btn" disabled=${!ready && e.collection?.collection !== 'clusters'} onClick=${() => v.openMap()}>Map</button>` : null}
          ${canFind && !find ? html`<button class="dk-btn icon" title=${`Find (${keycap('Mod+F', mod)})`} aria-label="Find" onClick=${() => setFind({q: ''})}><${Glyph} name="find" /></button>` : null}
          ${showCopy ? html`<button class="dk-btn icon" title=${e.kind === 'table' ? `Copy the sheet (${keycap('Mod+C', mod)} copies the selected cells)` : 'Copy the text'} aria-label="Copy"
            onClick=${() => v.copy(copyText())}><${Glyph} name="copy" /></button>` : null}
          ${showFile ? html`<button class="dk-btn icon" title=${e.recent ? 'Open the file' : 'Download the file and open it'} aria-label="Open file" disabled=${e.status === 'loading'}
            onClick=${() => v.openFile()}><${Glyph} name="download" /></button>` : null}
          ${hasDetails ? html`<button class="dk-btn icon dv-detbtn" aria-pressed=${detailsShown} aria-label="Details" title=${`${detailsShown ? 'Hide' : 'Show'} what was read from it${v.host.caps.corrections ? ', and correct it' : ''} (I)`}
            onClick=${() => { v.toggleDetails(); setRailAt(-1); }}><${Glyph} name="details" /></button>` : null}
          ${hasRail ? html`<button class="dk-btn dv-relbtn" aria-pressed=${railShown} title=${`${railShown ? 'Hide' : 'Show'} what this is joined to (R)`} onClick=${() => { if (detailsShown) v.toggleDetails(); if (!v.railShown || !detailsShown) v.toggleRail(); setRailAt(-1); }}>
            <${Glyph} name="related" size=${16} />${count ? html`<span class="n">${count}</span>` : null}</button>` : null}
          ${e.id != null ? html`<button class="dk-btn main dv-source" title=${`${sourceLabel(e)} (${keycap('Mod+Enter', mod)})`} onClick=${() => v.source()}>${sourceLabel(e)} ↗</button>` : null}
        </div>
      </header>
      <div class="dv-body">
        <div class="dv-main">${K ? html`<${K} v=${v} e=${e} pane=${pane} find=${find} mod=${mod} />` : html`<${State} v=${v} e=${e} />`}</div>
        ${detailsShown ? html`<aside class=${`dv-rail dv-details${sheetOpen ? ' open' : ''}`} aria-label="Details">
          <button class="dv-peek" onClick=${() => setSheetOpen(o => !o)} aria-expanded=${sheetOpen}><span class="dv-handle"></span>Details</button>
          <div class="dv-railin"><${Details} d=${v.detailsFor(e)} mod=${mod} /></div>
        </aside>` : null}
        ${railShown ? html`<aside class=${`dv-rail${sheetOpen ? ' open' : ''}`} aria-label="Related">
          <button class="dv-peek" onClick=${() => setSheetOpen(o => !o)} aria-expanded=${sheetOpen}><span class="dv-handle"></span>Related${count ? ` · ${count}` : ''}</button>
          <${Rail} v=${v} related=${related} entries=${entries} railAt=${railAt} mod=${mod} />
        </aside>` : null}
      </div>
      ${hints.length ? html`<footer class="dv-hint">${hints.map(([k, label]) => html`<span><kbd class="dk-key">${keycap(k, mod)}</kbd> ${label}</span>`)}</footer>` : null}
    </div>`;
}


/** Loading, failed, the site's no-preview, a Recent file (SPEC.md, *Viewer*: placeholders while it loads; the whole document failing a
 *  state block with Retry and the source). */
function State({v, e}) {
  if (e.status === 'loading') return html`<div class="dv-scroll"><div class="dv-pages"><div class="dv-page dk-ph" style="width:min(100%, 612px);aspect-ratio:612 / 792"></div></div></div>`;
  if (e.status === 'failed') return html`<div class="dk-state bad" role="alert"><div class="dk-tile"><${Glyph} name="warn" /></div>
    <b>${e.recent ? 'This device: item unavailable' : 'Document unavailable'}</b>
    <p>${e.error?.status === 401 ? v.enrollment().message : describeFailure(e.health ? 'allos' : e.recent ? 'This device' : 'bridge', e.error).message}</p>
    <div class="acts"><${StatusLink} host=${v.host} />${e.error?.status === 401 ? html`<button class="dk-btn" onClick=${() => v.reenroll()}>Reconnect device</button>` : !e.recent ? html`<button class="dk-btn" onClick=${() => v.retry()}>Retry</button><button class="dk-btn text" onClick=${() => v.source()}>${sourceLabel(e)} ↗</button>` : null}</div></div>`;
  if (e.status === 'none') return html`<div class="dk-state"><div class="dk-tile"><${Glyph} name="document" /></div><b>No preview for this kind of file</b>
    <p>Open it at its source${v.hasFile(e) ? ', or download it' : ''}.</p>
    <div class="acts"><button class="dk-btn" onClick=${() => v.source()}>${sourceLabel(e)} ↗</button>${v.hasFile(e) ? html`<button class="dk-btn" onClick=${() => v.openFile()}>Download</button>` : null}</div></div>`;
  if (e.kind === 'file') return html`<div class="dk-state"><div class="dk-tile"><${Glyph} name="document" /></div><b>No preview for ${e.title}</b>
    <p>${[e.recent?.path, e.recent?.size ? meta(e).replace(/^File · /, '') : null].filter(Boolean).join(' · ')}</p>
    ${v.hasFile(e) ? html`<div class="acts"><button class="dk-btn" onClick=${() => v.openFile()}>Open file</button></div>` : null}</div>`;
  return null;
}
