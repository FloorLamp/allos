import {PageHeader} from './page-header.js';
import {DuplicatesEntry, PeopleDuplicates, useDuplicates} from './people-duplicates.js';
import {PersonCard} from './person-profile.js';
import {subscribeFaces} from '../people-faces.js';
import {RecordRow} from './record-card.js';
import {CardPhotos} from './photo-strip.js';
import {CollectionEntityContent} from './viewer/collection.js';
import {amountText} from '../quantity.js';
import {countText, fieldLabel, plural} from '../format.js';
import {CollectionPager} from './collection-page.js';
import {openMap} from './map.js';
import {NavTiles} from './shell-bar.js';
import {Failure, Failures, StateBlock, StatusLink} from './page-state.js';
import {failurePage, paletteFailures, paletteQuiet} from '../failure.js';
// The palette (palette SPEC.md, *Layout*, *Rows*, *Preview*, *Answer*, *States*, *Groups*, *Keys*, *Look and motion*; DESIGN.md §3 P2–P3):
// the controller's rows in sections with their labels (`FOUND · searching…`, `All n ›`, Recent's Clear), the selection by id (kept in
// view), hover, the series chips, a group's rows sliding in, the answer with its citations, the asking and loading placeholders, the
// one state block; a click selects, a double click is Enter, a right click the row's keys (the host's `menu.popup`), a drag the
// host's `drag.start` (the site: the browser's own, the document's page as a link).
// With `box` it draws the search box (the breadcrumb in it, the placeholder by state, the indeterminate bar) and takes every SPEC key
// there: IME composition types (no model key while composing; Enter commits it), Mod+Backspace, Mod+Delete and Mod+Shift+Backspace
// on text clear the box as one undoable edit, the status line (a live region for screen readers) and the hint line. With `chrome` (a
// desktop's whole palette, P3) also, on the empty query, the commands bar (Send per target, all, Receive, Link: Mod held
// motion.modHold shows their keys; a chip flashes after its transfer) and, in the hotkey panel (the window cap), the header (the mark,
// DECK, pop out, close; Mod+Shift+O pops out too). `layout`: `panel` (a desktop's: rows up to sizes.visibleRows, then scroll; in Deck's
// own window, `.app.window`, the rows fill it) or `page` (the site's: full width, the page scrolls).
import {h} from '../../vendor/preact.mjs';
import {collectionTarget} from '../collection-target.js';
import {flightplanQuery, flightplanView} from '../flightplan.js';
import {PhoneLanding} from './phone-landing.js';
import {Recent} from './sections/recent.js';
import {useFold} from './sections/fold.js';
import {LandingProjects} from './sections/projects.js';
import {DueSoon} from './sections/due-soon.js';
import {Browse} from './sections/browse.js';
import {Asks} from './sections/asks.js';
import {useEffect, useLayoutEffect, useReducer, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {CLEARS, confirmVerb, groupOf, sourceName} from '../../../palette/model.mjs';
import {typeName} from '../controller.js';
import {Glyph} from '../glyphs.js';
import {keyName, keycap, plainText} from './keys.js';
import {Block, Label, Placeholders, Row, lines, scopeLabel, sectionOf} from './rows.js';
import {Later} from './deferred.js';
import {loadImage, mediaOf, peekBox, peekLayout, peeker} from './peek.js';

const html = htm.bind(h);
/** Keys the box hands to the model at once (the rest type, except where `takes` or the state says). */
const MODEL_KEYS = new Set(['Up', 'Down', 'Enter', 'Mod+Enter', 'Shift+Enter', 'Esc', 'Mod+Backspace', 'Mod+Delete', 'Mod+Shift+Backspace']);
const TRANSFER_KEYS = /^Mod\+([1-9]|S|R|P)$/;
const MODIFIERS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Process', 'Unidentified', 'Dead']);


/** What a key in the search box does: 'model' (c.key, the default prevented), 'clear' (the box's text cleared as one edit: Mod+Backspace,
 *  Mod+Delete, Mod+Shift+Backspace on text), else 'box' (it types, moves the caret, leaves). */
export function boxKey(c, k, box, {trapTab = true} = {}) {
  const st = c.state;
  if (CLEARS.has(k)) return box.value ? 'clear' : 'model';
  if (k === 'Space' || k === 'Left' || k === 'Right') return c.takes(k) ? 'model' : 'box';
  if (k === 'Backspace') return !box.value && st.scopes.length ? 'model' : 'box';
  // the site's page lets Tab leave the box where it opens nothing (a panel keeps it: SPEC.md, *Keys*)
  if (k === 'Tab') return trapTab || collectionTarget(c.selected()) || (groupOf(c.selected()) && !st.scopes.some(s => s.key === groupOf(c.selected())?.key)) ? 'model' : 'box';
  if (k === 'Shift+Tab') return trapTab || st.scopes.length ? 'model' : 'box';
  if (TRANSFER_KEYS.test(k)) return c.env.commands ? 'model' : 'box';
  return MODEL_KEYS.has(k) ? 'model' : 'box';
}

/** A motion token in ms (tokens.css `--t-*`), 0 under reduced motion (the system's or the host's) unless `always`. */
export function motionMs(name, {always = false} = {}) {
  const root = document.documentElement;
  if (!always && (root.dataset.motion === 'reduce' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)) return 0;
  return parseFloat(getComputedStyle(root).getPropertyValue(`--t-${name}`)) || 0;
}

/** What a screen reader hears (the live region): the status line, else what the rows hold once bridge answered. */
function announcement(c, rows, block) {
  if (c.status?.text) return c.status.text;
  if (c.asking && !c.state.answer) return 'Asking…';
  if (c.state.answer) return `Answer, ${plural(rows.length, 'source')}`;
  if (block) return [block.title, block.line].filter(Boolean).join('. ');
  const q = c.state.query.trim(), top = c.state.scopes.at(-1);
  if (top) return c.groups[top.key]?.busy ? '' : `${top.title}, ${plural(rows.length, 'row')}`;
  if (!q || c.find.busy) return '';
  return plural(rows.length, 'result');
}

/** c: the controller; mod: the platform's (`Meta` on the Mac); box, hint, chrome: draw them; layout `panel` | `page`;
 *  onPaint({what, ms}): rows painted after bridge's find answered (the budget's measure). */
export function Palette({c, mod = 'Control', box = true, hint = true, chrome = false, layout = 'panel', onPaint = null, autofocus = true, nav = [], asks = [], onAsk = null}) {
  const [, redraw] = useReducer(n => n + 1, 0);
  // subscribed as it commits: a change before an effect would run would be missed
  useLayoutEffect(() => c.subscribe(redraw), [c]);
  // a face linked or unlinked here: its person's rows show the portrait (or the initials) at once
  useEffect(() => subscribeFaces(redraw), []);
  const input = useRef(null), list = useRef(null), root = useRef(null), lastScopes = useRef(0), slide = useRef('');
  // an IME composition in the box (its text is not the query until it commits); when one ended (WebKit's Enter after it)
  const composing = useRef(false), composedAt = useRef(-1e9);
  const [held, setHeld] = useState(false);
  const [phone, setPhone] = useState(() => globalThis.matchMedia?.('(width < 600px)').matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.('(width < 600px)');
    if (!media) return undefined;
    const changed = () => setPhone(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const [duplicates, showDuplicates] = useState(false);
  c.expandLanding(phone && layout === 'page');
  const st = c.state, v = c.view(), allRows = c.rows(), top = st.scopes.at(-1), host = c.host;
  // the preview's place, measured on the list's area (its width) and the room it has (a window's: the area's height; a page's: the
  // viewport, the preview sticky beside the list)
  const main = useRef(null);
  const [room, setRoom] = useState({inline: null, width: 0, height: 0});
  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return undefined;
    const measure = () => {
      const width = el.clientWidth, height = layout === 'page' ? globalThis.innerHeight - 32 : el.clientHeight;
      const inline = peekLayout({width, viewport: {width: globalThis.innerWidth, height: globalThis.innerHeight}, fitted: !!host?.caps?.window});
      setRoom(r => r.inline === inline && r.width === width && r.height === height ? r : {inline, width, height});
    };
    measure();
    // next frame: a re-layout the new room causes is never a ResizeObserver loop
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
    ro?.observe(el);
    globalThis.addEventListener?.('resize', later);
    return () => { cancelAnimationFrame(frame); ro?.disconnect(); globalThis.removeEventListener?.('resize', later); };
  }, [host, layout]);
  // while an ask runs its placeholder holds the question: no Ask row repeating that one (a new query's Ask stays)
  const rows = c.asking && !st.answer ? allRows.filter(r => !(r.kind === 'ask' && r.query === c.asking)) : allRows;
  const pagedPeople = c.people() && !st.scopes.length && rows.some(row => row.person);
  const peopleWindow = c.peopleWindow();
  const loading = c.loading(), block = c.block(), chart = c.chart();
  // a browse scope: its selects say what it holds (the crumb only closes it); one source chosen, its rows' source chip is the selected row's
  const browse = c.browsing();

  // a group's rows slide in from the right (closing: back from the left)
  if (st.scopes.length !== lastScopes.current) { slide.current = st.scopes.length > lastScopes.current ? 'in' : 'back'; lastScopes.current = st.scopes.length; }

  useLayoutEffect(() => {
    const sel = list.current?.querySelector('.dp-row.sel');
    if (sel) sel.scrollIntoView?.({block: 'nearest'});
    else if (!v.selected && list.current && layout === 'panel') list.current.scrollTop = 0;
  }, [v.selected, rows.length, top?.key]);
  // the box shows the model's query (Esc clears it, a group empties it, closing one gives it back); never under a composition
  useLayoutEffect(() => { if (input.current && !composing.current && input.current.value !== st.query) input.current.value = st.query; });
  useLayoutEffect(() => { if (box && autofocus) input.current?.focus({preventScroll: true}); }, []);
  // each show starts in the box, wherever focus was when the panel hid (a viewer, a clicked row)
  useEffect(() => (box && autofocus && host?.on ? host.on('show', () => input.current?.focus({preventScroll: true})) : undefined), [host, box, autofocus]);
  // rows painted after a find answered: the next frame after the commit
  const painted = useRef(0);
  useLayoutEffect(() => {
    if (!onPaint || !c.foundAt || painted.current === c.foundAt) return;
    const at = c.foundAt;
    painted.current = at;
    requestAnimationFrame(() => onPaint({what: 'found', ms: performance.now() - at}));
  });
  // an outcome shows motion.status, fades, then the line goes (the panel shrinks)
  const status = c.status;
  const [fading, setFading] = useState(null);
  useEffect(() => {
    if (status?.kind !== 'ok') return;
    const shown = motionMs('status', {always: true});
    const f = setTimeout(() => setFading(status), shown), t = setTimeout(() => c.clearStatus(status), shown + 400);
    return () => { clearTimeout(f); clearTimeout(t); };
  }, [status]);

  // Mod held motion.modHold ms: the commands bar's keys over its chips (as the OS's own menus reveal shortcuts); any other key, its
  // release or leaving the window hides them
  useEffect(() => {
    if (!chrome) return;
    const modKey = mod === 'Meta' ? 'Meta' : 'Control';
    let timer = null;
    const off = () => { clearTimeout(timer); timer = null; setHeld(false); };
    const down = ev => {
      if (ev.key !== modKey) { off(); return; }
      if (ev.repeat || timer) return;
      timer = setTimeout(() => setHeld(true), motionMs('mod-hold', {always: true}));
    };
    const up = ev => { if (ev.key === modKey) off(); };
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    window.addEventListener('blur', off);
    return () => { off(); document.removeEventListener('keydown', down, true); document.removeEventListener('keyup', up, true); window.removeEventListener('blur', off); };
  }, [chrome, mod]);

  // Mod+Shift+O: Deck in its own window (the hotkey panel only: the window cap), wherever the keys are in the page
  useEffect(() => {
    if (!chrome || !host?.caps?.window) return;
    const on = ev => {
      if (ev.isComposing || keyName(ev, mod) !== 'Mod+Shift+O') return;
      ev.preventDefault(); ev.stopPropagation();
      c.popOut();
    };
    document.addEventListener('keydown', on, true);
    return () => document.removeEventListener('keydown', on, true);
  }, [c, chrome, mod, host]);

  // Mod+T: Texts (texts cap), wherever the keys are in the page
  useEffect(() => {
    if (!host?.caps?.texts) return;
    const on = ev => {
      if (ev.isComposing || keyName(ev, mod) !== 'Mod+T') return;
      ev.preventDefault(); ev.stopPropagation();
      c.texts();
    };
    document.addEventListener('keydown', on, true);
    return () => document.removeEventListener('keydown', on, true);
  }, [c, mod, host]);

  // keys outside the box (the page focused after a click; the site: `/` focuses the box); none while the page hides the palette
  // (Find showing a document in its place)
  useEffect(() => {
    const on = ev => {
      if (ev.defaultPrevented || ev.isComposing || c.viewer || root.current?.closest('[hidden]')) return;
      const t = ev.target;
      if (t === input.current || (t !== document.body && t !== document.documentElement && !root.current?.contains(t))) {
        if (box && ev.key === '/' && !t.closest?.('input, textarea, select, [contenteditable]')) { ev.preventDefault(); input.current?.focus(); input.current?.select(); }
        return;
      }
      if (t.closest?.('input, textarea, select, .dk-drawer-wrap, .dp-phone-landing button, .dk-collection-pager, .dp-card button')) return;
      const k = keyName(ev, mod);
      if (box && k === '/') { ev.preventDefault(); input.current?.focus(); return; }
      if (!['Up', 'Down', 'Enter', 'Mod+Enter', 'Shift+Enter', 'Esc', 'Tab', 'Shift+Tab', 'Space', 'Left', 'Right', 'Mod+Backspace', 'Mod+Delete'].includes(k)) return;
      if ((k === 'Tab' || k === 'Shift+Tab') && boxKey(c, k, {value: c.state.query}, {trapTab: layout === 'panel'}) === 'box') return;
      ev.preventDefault();
      c.key(k);
      if (box) input.current?.focus({preventScroll: true});
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [c, box, mod]);

  const onBoxKey = ev => {
    // an IME composing: its keys are the IME's (Enter commits the composition, never runs a row); WebKit sends the commit's Enter
    // after compositionend, as keyCode 229
    if (ev.isComposing || composing.current || ev.keyCode === 229) return;
    if (ev.key === 'Enter' && ev.timeStamp - composedAt.current < 50) return;
    const k = keyName(ev, mod), does = boxKey(c, k, ev.target, {trapTab: layout === 'panel'});
    if (does === 'clear') { ev.preventDefault(); clearBox(ev.target); return; }
    if (does !== 'model') {
      // any other key cancels a pending confirmation, then does its own thing (letters type: the edit cancels it too)
      if (c.state.confirm && !MODIFIERS.has(ev.key)) c.key('Other');
      return;
    }
    ev.preventDefault();
    c.key(k);
  };
  // a click on the panel's buttons or its bare parts leaves the keys in the box (letters always type there); a row's own press stays
  // (its drag), and the row's click focuses the box itself
  const keepFocus = ev => {
    const t = ev.target;
    if (ev.button !== 0 || t === input.current || t.closest?.('input, textarea, select, .dp-answertext, .dk-drawer-wrap') || (t.closest?.('.dp-row') && !t.closest('button'))) return;
    ev.preventDefault();
    if (document.activeElement !== input.current) input.current?.focus({preventScroll: true});
  };
  const onInput = ev => { if (!ev.isComposing && !composing.current) c.edit(ev.target.value); };
  /** The box emptied as the browser's own one edit (Undo brings the text back), its input event the model's edit; where the browser
   *  will not, emptied here and edited. */
  const clearBox = el => {
    el.select();
    if (!document.execCommand?.('delete') || el.value) { el.value = ''; c.edit(''); }
  };
  // (lower case: Preact keeps an unknown `on…` prop's case as the event's name, and there is no `oncompositionstart` property)
  const onCompositionStart = () => { composing.current = true; };
  const onCompositionEnd = ev => { composing.current = false; composedAt.current = ev.timeStamp; c.edit(ev.target.value); };

  // a native drag session (drag.start) swallows the mouseup: clicks wait until it settles, then the pointer starts afresh
  const dragging = useRef(false);
  const act = {
    swipe: c.platform?.platform === 'android' ? id => c.swipeRemove(id) : null,
    // a record's first click (a tap) selects it, its card in place; a click on the selected record opens it (SPEC.md, *Record card*)
    select: id => {
      if (dragging.current) return;
      const row = c.rows().find(r => r.id === id), record = row?.kind !== 'collection' && !!collectionTarget(row);
      if (record ? c.view().selected === id : (host.kind === 'web' || c.platform?.platform === 'android') && layout === 'page' && window.matchMedia('(width < 600px)').matches) c.openRow(id);
      else c.select(id);
      if (box) input.current?.focus({preventScroll: true});
    },
    open: id => { if (!dragging.current) c.openRow(id); },
    // Find's photos (SPEC.md, *Photos*): a thumbnail its photo in the viewer, `+n` all of them
    photos: (set, at = null) => { if (!dragging.current) c.viewPhotos(set, at); },
    group: id => c.openGroupOf(id),
    chip: (id, i, o) => c.chip(id, i, o),
    confirm: yes => { c.key(yes ? 'Enter' : 'Esc'); if (box) input.current?.focus({preventScroll: true}); },
    source: id => c.source(id),
    dragOf: id => c.dragOf(id),
    menu: (ev, id) => {
      if (!host.caps.menus) return;
      ev.preventDefault();
      c.select(id);
      // each a model key (`Mod+Enter`, `Remove`) and its shortcut as a model key name, which the shell draws as its own menu's
      const items = c.menuFor(id);
      if (!items.length) return;
      host.call('menu.popup', {items, at: {x: Math.round(ev.clientX), y: Math.round(ev.clientY)}}).then(r => { const k = typeof r === 'string' ? r : r?.id; if (k) c.menuPick(id, k); }, () => {});
    },
    drag: (ev, id, payload) => {
      if (!payload) { ev.preventDefault(); return; }
      if (host.caps.drag) {
        // the shell's own drag session, its data from the payload (contract/README.md, drag.start)
        ev.preventDefault();
        dragging.current = true;
        const done = () => { dragging.current = false; document.querySelectorAll(':active, .dp-row:hover').forEach(e => e.blur?.()); };
        host.call('drag.start', payload).then(done, done);
        return;
      }
      // the site: the browser drags the document's page, or the text
      const dt = ev.dataTransfer;
      if (!dt) return;
      if (payload.kind === 'document') {
        const url = new URL(`/doc/${payload.id}`, location.href).href;
        dt.setData('text/uri-list', url);
        dt.setData('text/plain', url);
      } else if (payload.text) dt.setData('text/plain', payload.text);
      dt.effectAllowed = 'copy';
    },
  };

  const landingFold = useFold(host);
  // the rows in their sections
  const out = [];
  let section = null, n = 0, foundShown = false;
  let landingGroup = null;
  const idleLanding = !st.query && !st.scopes.length && !st.answer;
  const phoneLanding = phone && layout === 'page' && idleLanding && !c.asking;
  // the landing's sections say their own empties (Recent's), so the rows' block shows (and is said) only for a failure there
  const shownBlock = block && !(phoneLanding && !block.warn) ? block : null;
  const busyFound = loading === 'found';
  const foundPlaceholder = () => { foundShown = true; out.push(html`<${Label} key="label:found-ph" text="FOUND · searching…" />`, html`<${Placeholders} key="ph:found" n=${2} />`); };
  // a collection record the words name leads under its collection's name (`VEHICLES`), apart from FOUND below the actions
  const labelOf = row => top ? scopeLabel(top.key, rows) : row.lead ? row.lead.toUpperCase() : sectionOf(row.kind);
  const projects = !phoneLanding && host?.backends?.includes('flightplan') ? html`<${LandingProjects} host=${host} fold=${landingFold} platform=${c.platform?.platform}
    idle=${idleLanding && !c.asking} />` : null;
  let projectsAdded = false;
  // the landing's failures in the place of the section they empty, once each (a phone's Today and Projects say flightplan's own)
  const failures = paletteFailures(c), landingPage = layout === 'page' && idleLanding && !c.asking;
  const placed = place => (landingPage ? failures.filter(f => f.place === place && !(phoneLanding && f.backend === 'flightplan' && host.backends?.includes('flightplan'))) : []);
  const placedEl = place => placed(place).length ? html`<${Failures} key=${`landing:${place}-failures`} failures=${placed(place)} host=${host} />` : null;
  // a source that failed for a query about something else, with results: one quiet line under them, not a block over them
  const found = !!st.query.trim() && rows.some(r => !QUIET_NONE.has(r.kind));
  const {quiet, loud} = paletteQuiet(landingPage ? failures.filter(f => f.place === 'list') : failures, {query: st.query, results: found, host});
  // what is due first, under the codes (a phone's says it in its own composition), then Needs you (its failure in its place)
  const dueSoon = idleLanding && !c.asking && !phoneLanding ? html`<${DueSoon} key="landing:due-soon" host=${host} idle=${true} fold=${landingFold} onOpen=${id => c.viewRef(id)} />` : null;
  let led = false;
  const lead = () => { if (!led) out.push(dueSoon, phoneLanding ? null : placedEl('needs')); led = true; };
  if (loading === 'recent') { lead(); out.push(html`<${Placeholders} key="ph:recent" n=${c.recentCount} />`); }
  for (const [i, row] of rows.entries()) {
    // Projects under the codes and Needs you (first on every landing, as the phone's), above the rest
    if (row.kind !== 'code') lead();
    if (row.kind !== 'code' && row.kind !== 'needs' && !projectsAdded) { out.push(projects); projectsAdded = true; }
    const name = labelOf(row);
    // Recent's rows under their folding section; the House and Needs you rows stand alone (a section of one row titled as it repeats it)
    const Component = idleLanding && row.kind === 'recent' ? Recent : null;
    if (Component && landingGroup?.kind !== row.kind) {
      landingGroup = {kind: row.kind, rows: []};
      out.push(html`<${Component} key=${`landing:${row.kind}`} rows=${landingGroup.rows} fold=${landingFold}
        more=${Math.max(0, c.sectionMore(row.kind) - rows.filter(r => r.kind === row.kind).length)}
        onMore=${() => c.openGroupOf(row.id)} onClear=${row.kind === 'recent' && host.caps.recent ? () => c.clearRecent() : null}
        renderRow=${r => r} />`);
    } else if (!Component) landingGroup = null;
    const target = Component ? landingGroup.rows : out;
    if (busyFound && !foundShown && name !== 'FOUND' && (row.kind === 'recent' || (row.kind === 'command' && i > 0 && rows[i - 1].kind !== 'command'))) foundPlaceholder();
    if (name === 'FOUND') foundShown = true;
    if (name && name !== section && !Component && row.kind !== 'house') {
      const more = c.sectionMore(row.kind);
      target.push(html`<${Label} key=${`label:${name}:${i}`} text=${name === 'FOUND' && busyFound ? 'FOUND · searching…' : name}
        all=${more ? `All ${more} ›` : null} onAll=${() => c.openGroupOf(row.id)}
        clear=${row.kind === 'recent' && host.caps.recent} onClear=${() => c.clearRecent()} />`);
    }
    section = name;
    if (row.kind === 'citation') n++;
    const selected = row.id === v.selected;
    const confirm = selected && (st.confirm?.what === 'act' || st.confirm?.what === 'remove') ? confirmVerb(st.confirm, c.env) : null;
    // a card's photos (the person card's, a record's): its strip (record-card.js)
    const photos = row.photos ? {set: row.photos, host, open: at => act.photos(row.photos, at), all: () => act.photos(row.photos)} : null;
    if (row.card) { target.push(html`<${CardPhotos.Provider} key=${row.id} value=${photos}><${PersonCard} row=${row} rows=${rows} selected=${selected} rowId=${`dp-r-${i}`} host=${host} act=${act}
      onCopy=${value => c.copy(value)} onView=${id => c.viewRef(id)} focus=${c.cardFocus?.id === row.id ? c.cardFocus.n : 0} onFocused=${() => { c.cardFocus = null; }}
      onLeave=${() => input.current?.focus({preventScroll: true})} onArrow=${k => c.key(k)} /><//>`); continue; }
    // the selected record: its card under it, in place (SPEC.md, *Record card*); Enter or Open › the whole record
    const record = selected && row.kind !== 'collection' ? collectionTarget(row.result ?? row) : null;
    if (record) {
      const l = lines(row, {n, mod});
      target.push(html`<${CardPhotos.Provider} key=${row.id} value=${photos}><${RecordRow} row=${row} lines=${l} glyph=${l.glyph} rowId=${`dp-r-${i}`} act=${act} host=${host}
        focus=${c.cardFocus?.id === row.id ? c.cardFocus.n : 0} onFocused=${() => { c.cardFocus = null; }} onLeave=${() => input.current?.focus({preventScroll: true})} onArrow=${k => c.key(k)}
        card=${html`<${CollectionEntityContent} compact=${true} host=${host} target=${record} onOpen=${d => d?.id != null && c.viewRef(d.id)} onRecord=${t => c.viewRecord(t)} onFull=${() => act.open(row.id)} />`} /><//>`);
      continue;
    }
    target.push(html`<${Row} key=${row.id} row=${row} n=${n} selected=${selected} confirm=${confirm} copied=${c.copied === row.id}
      focus=${selected && row.kind === 'series' ? v.series?.chip ?? null : null} act=${act} mod=${mod} host=${host} rowId=${`dp-r-${i}`} />`);
  }
  if (busyFound && !foundShown) foundPlaceholder();
  lead();
  if (!projectsAdded) out.push(projects);
  // the site's landing sections below the rows: each source to browse, the questions asked lately
  if (idleLanding && !c.asking && !phoneLanding) out.push(placedEl('house'),
    host.caps.browse && c.facets?.sources?.length ? html`<${Browse} key="landing:browse" sources=${c.facets.sources} fold=${landingFold} host=${host} onBrowse=${f => { c.browse(f); input.current?.focus({preventScroll: true}); }} />` : null,
    html`<${Asks} key="landing:asks" asks=${asks} onAsk=${onAsk} fold=${landingFold} />`);
  if (loading === 'group') out.push(html`<${Placeholders} key="ph:group" n=${5} />`);

  const answer = st.answer;
  const selAt = rows.findIndex(r => r.id === v.selected);
  // the selected person's possible duplicates, in People (the owner's only)
  const duplicateOf = c.people() ? rows[selAt]?.person?.id ?? null : null, review = useDuplicates(host, duplicateOf, {enabled: duplicateOf != null});
  // the focused row's media beside it (SPEC.md, *Preview*); none while the viewer shows
  const peekPath = !c.viewer && selAt >= 0 ? mediaOf(rows[selAt], host.caps) : null;
  const neighbours = [rows[selAt - 1], rows[selAt + 1]].map(r => mediaOf(r, host.caps));
  const bar = loading === 'found' && !c.find.partial || !!c.asking || loading === 'group';
  // nothing closes on a page without a window (the site): no `Esc Close`
  // the site's page shows keys only with something to choose among (a query, a group, an answer); its landing's sections need none
  const hints = hint && !(layout === 'page' && idleLanding && !c.asking) ? v.hint.filter(([k, l]) => host.caps.window || !(k === 'Esc' && l === 'Close')) : [];
  const said = box ? announcement(c, rows, shownBlock) : '';

  const boxEl = box ? html`<div class="dp-boxwrap">
    <div class="dp-box">
      <${Glyph} name="find" size=${18} class="dp-boxglyph" />
      ${v.scope ? html`<button type="button" class="dp-crumb" tabindex="-1" title="Close the group (Shift+Tab)" aria-label=${`Close ${v.scope.join(', ')}`}
        data-scope=${JSON.stringify(v.scope)} onClick=${() => { c.key('Shift+Tab'); input.current?.focus(); }}><${Glyph} name="close" size=${12} />${browse ? 'Browse' : v.scope.join(' › ')}</button>` : null}
      ${/^(cluster|day|subject):/.test(st.scopes.at(-1)?.key ?? '') ? html`<button type="button" class="dk-btn" onClick=${() => { const scope = st.scopes.at(-1), at = scope.key.indexOf(':'); openMap(host, {by: scope.key.slice(0, at), value: scope.key.slice(at + 1), label: scope.title}); }}>Map</button>` : null}
      <input ref=${plainText(input)} class="dp-input" type="text" role="combobox" aria-expanded=${!phoneLanding && rows.length ? 'true' : 'false'} aria-controls=${phoneLanding ? null : 'dp-list'} aria-autocomplete="list"
        aria-haspopup="listbox" aria-activedescendant=${!phoneLanding && selAt >= 0 ? `dp-r-${selAt}` : null} aria-label="Search" aria-describedby=${hints.length && !phoneLanding ? 'dp-hint' : null}
        placeholder=${browse ? 'Filter these documents' : layout === 'page' && !st.scopes.length ? 'Search or ask Deck' : phone && st.scopes.length ? 'Filter' : c.placeholder()} enterkeyhint="search"
        onInput=${onInput} onKeyDown=${onBoxKey} oncompositionstart=${onCompositionStart} oncompositionend=${onCompositionEnd} />
      ${st.query.trim() ? html`<button type="button" class="dk-btn text" aria-label="Ask Deck" title="Ask (Shift+Enter)" disabled=${!!c.asking}
        onClick=${() => { if (!composing.current) c.key('Shift+Enter'); }}>Ask</button>` : null}
    </div>
    <div class=${`dp-bar${bar ? ' on' : ''}`} aria-hidden="true"></div>
  </div>` : null;
  // the line a person sees, and what a screen reader hears (one polite live region, in the page from the start)
  // a confirmation: the question, its buttons here unless its row holds them (the keys are the hint line's)
  const statusEl = box && status ? html`<div class=${`dp-status ${status.kind}${fading === status ? ' fading' : ''}`} key=${status.text}>
    ${status.kind === 'ok' ? html`<${Glyph} name="check" size=${14} />` : status.kind === 'bad' ? html`<${Glyph} name="warn" size=${14} />` : null}<span>${status.ask ?? status.text}</span>
    ${status.kind === 'confirm' && !status.row ? html`<button class="dk-btn" onClick=${() => act.confirm(true)}>${status.verb}</button><button class="dk-btn" onClick=${() => act.confirm(false)}>Cancel</button>` : null}
    ${status.kind === 'bad' ? html`<${StatusLink} host=${host} />` : null}
    ${status.retry ? html`<button class="dk-btn" onClick=${status.retry}>Retry</button>` : null}
    ${status.undo ? html`<button class="dk-btn" onClick=${status.undo}>Undo</button>` : null}
    ${status.signIn ? html`<button class="dk-btn" onClick=${status.signIn}>Sign in to save</button>` : null}
    ${status.kind === 'busy' ? html`<span class="dp-statusbar"></span>` : null}</div>` : null;
  const liveEl = box ? html`<div class="dk-sr" id="dp-live" role="status" aria-live="polite" aria-atomic="true">${said}</div>` : null;
  const hintEl = hints.length ? html`<div class="dp-hint" id="dp-hint" data-hint=${JSON.stringify(v.hint)}>${hints.map(([k, label]) => html`<span key=${k}><kbd class="dk-key">${keycap(k, mod)}</kbd> ${label}</span>`)}</div>` : null;

  return html`<div class=${`dp ${layout}${layout === 'page' ? ' dk-page' : ''}${c.people() ? ' people' : ''}${chrome ? ' chrome' : ''}`} ref=${root} onMouseDown=${box ? keepFocus : null} data-query=${st.query} data-selected=${v.selected ?? ''} data-confirm=${st.confirm?.what ?? ''}
    data-answer=${answer ? 'true' : 'false'} data-scope=${v.scope ? JSON.stringify(v.scope) : ''} data-busy=${c.find.busy ? 'true' : 'false'}>
    ${layout === 'page' ? html`<${PageHeader} title="Find" description="Search your documents or ask a question." />` : null}
    ${c.find.warming ? html`<${StateBlock} inline=${true} line="Find is starting, showing your last results" />` : null}
    ${chrome && host?.caps?.window ? html`<${Header} c=${c} mod=${mod} />` : null}
    ${boxEl}
    ${layout === 'page' && !phone && nav.length && !st.query && !st.scopes.length && !st.answer && !c.asking ? html`<${NavTiles} nav=${nav} current="search" />` : null}
    ${c.people() ? html`<div class="dp-filters wrap"><label class="dp-filterlabel">Relation <select class="dk-field dp-filter" aria-label="Relation filter" value=${c.peopleRelation} onChange=${e => c.relation(e.currentTarget.value)}><option value="">All relations</option>${[...new Set([...c.peopleRelations, c.peopleRelation].filter(Boolean))].map(r => html`<option value=${r}>${fieldLabel(r)}</option>`)}</select></label>
      ${duplicateOf != null ? html`<${DuplicatesEntry} review=${review} open=${duplicates} onToggle=${showDuplicates} />` : null}</div>` : null}
    ${browse && c.facets ? html`<${Filters} c=${c} f=${browse} />` : null}
    ${layout === 'page' && !phoneLanding ? hintEl : null}
    <${Failures} failures=${loud} host=${host} />
    ${layout === 'page' ? statusEl : null}
    ${c.asking && !answer ? html`<section class="dp-answer asking" aria-busy="true"><div class="dk-label">Answer</div>
      <span class="dk-ph" style="width:92%;height:12px"></span><span class="dk-ph" style="width:84%;height:12px"></span><span class="dk-ph" style="width:56%;height:12px"></span>
      <p class="dp-asking">Asking…</p></section>` : null}
    ${answer ? html`<${Answer} a=${answer} c=${c} />` : null}
    ${chart?.error ? html`<${Failure} backend="bridge" error=${chart.error} retry=${() => c.retryChart()} host=${host} />` : null}
    ${chart?.data?.points?.length ? html`<${Later} name="Chart" key=${`chart:${top.key}`} data=${chart.data} label=${chart.data.title} onOpen=${ref => c.viewRef(ref)} />` : null}
    ${flightplanQuery(st.query) && !st.scopes.length ? html`<${Later} name="PaletteFlightplan" key=${flightplanView(st.query)} host=${host} view=${flightplanView(st.query)} />` : null}
    ${duplicateOf != null ? html`<${PeopleDuplicates} key=${duplicateOf} host=${host} review=${review} open=${duplicates} onClose=${() => showDuplicates(false)} />` : null}
    <div class=${`dp-main${room.inline ? ` ${room.inline}` : ''}`} ref=${main}>
    <${Peek} path=${peekPath} neighbours=${neighbours} host=${host} room=${room} onOpen=${() => selAt >= 0 && act.open(rows[selAt].id)} />
    <div class=${`dp-rows${slide.current ? ` slide-${slide.current}` : ''}${browse?.source ? ' one-source' : ''}`} key=${`list:${top?.key ?? ''}`} id="dp-list" role=${phoneLanding ? null : 'listbox'} aria-label=${top ? top.title : 'Results'}
      ref=${list}>
      ${phoneLanding ? html`<${PhoneLanding} c=${c} rows=${rows} fold=${landingFold} needsState=${placedEl('needs')} houseState=${placedEl('house')} asks=${asks} onAsk=${onAsk} renderRow=${row => html`<${Row} key=${row.id} row=${row} needAnswer=${true} copied=${c.copied === row.id}
        confirm=${row.id === v.selected && st.confirm?.what === 'act' ? confirmVerb(st.confirm, c.env) : null}
        act=${act} host=${host} mod=${mod} rowId=${`dp-r-${rows.indexOf(row)}`} selected=${row.id === v.selected} />`} />` : out}</div>
    </div>
    ${top && c.groupWindow()?.pages > 1 ? html`<${CollectionPager} label="Group pages" page=${{...c.groupWindow(), turn: n => c.turnGroup(n)}} />` : null}
    ${pagedPeople && peopleWindow.pages > 1 ? html`<${CollectionPager} label="People pages" page=${{...peopleWindow, turn: n => c.turnPeople(n)}} />` : null}
    ${shownBlock ? html`<${Block} b=${shownBlock} live=${!box} onAction=${() => c.blockAction()} />` : null}
    ${quiet.length ? html`<${QuietFailures} failures=${quiet} />` : null}
    ${chrome && c.commandsBar() ? html`<${Commands} c=${c} mod=${mod} held=${held} />` : null}
    ${layout === 'panel' ? statusEl : null}
    ${layout === 'panel' ? hintEl : null}
    ${liveEl}
    ${chrome ? html`<span class="dp-hud" aria-hidden="true"></span>` : null}
  </div>`;
}

// rows that are not results: the ask row, the none row, the commands
const QUIET_NONE = new Set(['ask', 'none', 'command']);
/** Sources that did not answer a query about something else (failure.js paletteQuiet): one quiet line under the results, `House didn’t
 *  answer · Retry`, its Retry each of them again. */
function QuietFailures({failures}) {
  const names = [...new Set(failures.map(f => failurePage(f.backend)))];
  const said = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const retry = failures.filter(f => f.retry);
  return html`<p class="dp-quiet-failure" role="status"><span>${said} didn’t answer</span>${retry.length ? html`<span aria-hidden="true">·</span>
    <button type="button" class="dk-btn text" onClick=${() => retry.forEach(f => f.retry())}>Retry</button>` : null}</p>`;
}

/** A shell draws the preview in a separate non-activating window (when it has side room); otherwise it shows in the page where `room`
 *  says (`split`: beside the list, the page's aspect; `above`; none: nothing loads). */
function Peek({path: wantedPath, neighbours, host, room, onOpen}) {
  const path = host.caps.window || room.inline ? wantedPath : null;
  const [shown, setShown] = useState(null), [outside, setOutside] = useState(null);
  const loads = useRef(null), serial = useRef(0), current = useRef(path), adjacent = useRef(neighbours);
  current.current = path;
  adjacent.current = neighbours.filter(Boolean);
  loads.current ??= peeker({resource: p => host.resource(p), load: loadImage, onShow: picture => {
    setShown(picture);
    const n = ++serial.current;
    setOutside(null);
    if (host.caps.window) host.call('window.preview', {path: picture?.path ?? null, neighbours: picture ? adjacent.current : []}).then(ok => {
      if (serial.current === n) setOutside(ok === true);
    }, () => { if (serial.current === n) setOutside(false); });
  }});
  useEffect(() => { loads.current.want(path); }, [path]);
  useEffect(() => {
    if (shown?.path === path) loads.current.prefetch(neighbours);
  }, [shown, path, neighbours.join('|')]);
  useEffect(() => {
    const hide = () => { loads.current.want(null); };
    const offHide = host.on('hide', hide), offShow = host.on('show', () => loads.current.want(current.current));
    return () => { offHide(); offShow(); hide(); loads.current.stop(); };
  }, [host]);
  if (!shown || shown.path !== path || (host.caps.window && outside !== false) || !room.inline) return null;
  const box = room.inline === 'split' ? peekBox({width: room.width, height: room.height - 16, aspect: shown.w && shown.h ? shown.w / shown.h : 0}) : null;
  return html`<div class="dp-peek" aria-hidden="true" data-path=${shown.path} onClick=${onOpen} style=${box ? `width: ${box.w}px; height: ${box.h}px` : null}>
    <img src=${shown.url} alt="" draggable="false" /></div>`;
}

/** The hotkey panel's header (SPEC.md, *Layout*): the mark (three dots climbing, the craft in accent), `DECK`, pop out (Deck in its own
 *  window), close; the window's drag region (`data-window-drag`, its buttons excepted: app.js asks the shell's `window.drag`). */
function Header({c, mod}) {
  return html`<header class="dp-head" data-window-drag>
    <svg class="dp-mark" width="18" height="18" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="12" cy="57" r="5" /><circle cx="15.6" cy="36.9" r="5.8" /><circle cx="27.3" cy="21.9" r="6.6" /><circle class="craft" cx="54" cy="12" r="8.5" />
    </svg>
    <span class="dp-brand">DECK</span>
    <button type="button" class="dk-btn icon text dp-popout" tabindex="-1" aria-label="Open in a window" aria-keyshortcuts=${mod === 'Meta' ? 'Meta+Shift+O' : 'Control+Shift+O'}
      title=${`Open in a window (${keycap('Mod+Shift+O', mod)})`} onClick=${() => c.popOut()}><${Glyph} name="popout" size=${14} /></button>
    <button type="button" class="dk-btn icon text dp-close" tabindex="-1" aria-label="Close" title=${`Close (${keycap('Esc', mod)})`} onClick=${() => c.close()}>
      <${Glyph} name="close" size=${14} /></button>
  </header>`;
}

/** The commands bar (SPEC.md, *Layout*): `Send`, a chip per target (dimmed when not enrolled), `all`; Receive; Link; Texts (texts cap). A click is the
 *  chip's key; `held` (Mod held): each chip's key over it; the chip a transfer went through flashes `ok` with a tick. */
function Commands({c, mod, held}) {
  const busy = !!c.transferring;
  const chip = ({id, label, key, title, dim = false, run = () => c.key(key)}) => {
    const on = c.flash === id;
    return html`<button type="button" key=${id} tabindex="-1" class=${`dp-cmd${on ? ' flash' : ''}${dim ? ' dim' : ''}`} data-chip=${id} disabled=${busy}
      title=${title} aria-label=${title} aria-keyshortcuts=${key.replace('Mod', mod === 'Meta' ? 'Meta' : 'Control')} onClick=${run}>
      <span class="dp-cmdname">${label}</span>${on ? html`<${Glyph} name="check" size=${14} class="dp-tick" />` : null}
      ${held ? html`<kbd class="dk-key dp-cap">${keycap(key, mod)}</kbd>` : null}</button>`;
  };
  const targets = c.env.targets.slice(0, 9);
  return html`<div class="dp-cmds" role="toolbar" aria-label="Commands">
    <span class="dp-cmdlabel">Send</span>
    ${targets.map((t, i) => {
      const dim = !!c.enrolled && !c.enrolled.includes(t);
      return chip({id: t, label: t, key: `Mod+${i + 1}`, dim, title: dim ? `${t} is not enrolled` : `Send to ${t} (${keycap(`Mod+${i + 1}`, mod)})`});
    })}
    ${chip({id: 'all', label: 'all', key: 'Mod+S', title: `Send to every other device (${keycap('Mod+S', mod)})`})}
    <span class="dp-cmdsep" aria-hidden="true"></span>
    ${chip({id: 'receive', label: 'Receive', key: 'Mod+R', title: `Receive what is waiting (${keycap('Mod+R', mod)})`})}
    <span class="dp-cmdsep" aria-hidden="true"></span>
    ${chip({id: 'share', label: 'Link', key: 'Mod+P', title: `Create a public link to the clipboard (${keycap('Mod+P', mod)})`})}
    ${c.host.caps.texts ? [html`<span class="dp-cmdsep" key="texts-sep" aria-hidden="true"></span>`,
      chip({id: 'texts', label: 'Texts', key: 'Mod+T', title: `Recent texts (${keycap('Mod+T', mod)})`, run: () => c.texts()})] : null}
  </div>`;
}

/** A browse scope's filters (the site's filtered browse, folded in as a group): source, type, year and the order; a change replaces
 *  the scope. */
function Filters({c, f}) {
  const fc = c.facets, set = (k, v) => c.browse({...f, [k]: v || undefined});
  // bridge's facet counts are over every document: a count shows only while no other filter narrows the list, never on the chosen
  // option (the rows' label counts what the list holds)
  const pick = (k, label, items, name = x => x) => {
    const counted = !['source', 'type', 'year'].some(o => o !== k && f[o]);
    return html`<select class="dk-field dp-filter" aria-label=${label} value=${f[k] ?? ''} onChange=${ev => set(k, ev.target.value)}>
      <option value="">${label}</option>${items.map(x => html`<option key=${x.v} value=${x.v}>${name(x.v)}${counted && String(x.v) !== String(f[k] ?? '') ? ` (${countText(x.n)})` : ''}</option>`)}</select>`;
  };
  return html`<div class="dp-filters">
    ${pick('source', 'All sources', fc.sources ?? [], v => sourceName(v) ?? v)}
    ${pick('type', 'All types', fc.types ?? [], typeName)}
    ${pick('year', 'Any year', fc.years ?? [])}
    <select class="dk-field dp-filter" aria-label="Order" value=${f.sort === 'oldest' ? 'oldest' : ''} onChange=${ev => set('sort', ev.target.value)}>
      <option value="">Newest first</option><option value="oldest">Oldest first</option></select>
  </div>`;
}

/** The answer (SPEC.md, *Answer*): `ANSWER`, the text (selectable), `Not sure` when its confidence is low (then `Search instead`:
 *  Esc), each cluster as a line (`Backyard landscaping · $14,860`, a click opens its group); its citations follow as rows. */
function Answer({a, c}) {
  const unsure = a.confidence === 'low' || a.confidence === 'none';
  return html`<section class="dp-answer">
    <div class="dp-answerhead"><span class="dk-label">Answer</span>${unsure ? html`<span class="dp-unsure">Not sure</span>` : null}</div>
    <div class="dp-answertext">${a.answer ?? ''}</div>
    ${(a.clusters ?? []).map(p => html`<button type="button" key=${p.id} class="dp-cluster" onClick=${() => c.openGroup(`cluster:${p.id}`, p.name)}>
      <${Glyph} name="cluster" size=${14} />${[p.name, (p.totals ?? []).map(t => amountText(t, {precision: Number.isInteger(Number(t.amount)) ? 0 : 2})).join(', ')].filter(Boolean).join(' · ')}</button>`)}
    ${unsure ? html`<div><button type="button" class="dk-btn text" onClick=${() => c.key('Esc')}>Search instead</button></div>` : null}
  </section>`;
}
