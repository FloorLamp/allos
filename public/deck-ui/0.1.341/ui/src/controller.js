export {textsWhen} from './quantity.js';
import {textsWhen} from './quantity.js';
import {mergeNeeds} from './needs.js';
import {describeFailure} from './failure.js';
import {lookupAnswer, planQuery, spendingQuery, spendingResults} from './lookups.js';
import {createFlightplan, mergeFound, planAnswer, planSearch} from './flightplan.js';
// The palette's controller (DESIGN.md §2): the model's state and env, each key, edit and click through palette/model.mjs, each
// effect as host ops (contract/README.md), bridge's answers back into env. No DOM: the views (view/palette.js, rows.js) render `view()`,
// `rows()` and `block()` and call `key`, `edit`, `select` and the row's mouse actions (`chip`, `source`, `openRow`, `menu`, `drag`);
// npm test drives cases.json and the effects through it with the fake host.
import * as model from '../../palette/model.mjs';
import {healthIdentity, healthQuery, healthResults, healthKey} from './health.js';
import {hostError, openable} from './host/host.js';

/** Rows a pick (Enter, a tap) puts first next time (SPEC.md, *Rows*: commands, found, a group's documents). */
const PICKED = new Set(['command', 'identifier', 'link', 'document', 'series', 'cluster', 'topic', 'area', 'thing', 'person', 'trip', 'trips', 'event', 'day']);

/** The Texts group's key (SPEC.md, *Texts*): the owner's conversations, newest first; a conversation's row id `doc:texts:<id>`. */
export const TEXTS = 'texts:recent';
const textsRow = row => typeof row?.result?.document?.id === 'string' && row.result.document.id.startsWith('texts:');

/** A conversation's newest message as its row's second line: `You: …` (the owner's), `Pat: …` (a group's), its text; a code hidden. */
export function textsLine(last, group = false) {
  if (!last) return '';
  if (last.hidden === 'code') return 'Verification code hidden';
  const text = String(last.text ?? '').replace(/\s+/g, ' ').trim() || (last.media > 1 ? `${last.media} attachments` : last.media ? 'Attachment' : '');
  const who = last.me ? 'You' : group ? String(last.from ?? '').split(' ')[0] : '';
  return who ? `${who}: ${text}` : text;
}
/** bridge's Texts list (bridge.texts) as a group's items: each conversation a document row (a chat glyph, `Messages ↗`), titled
 *  by who it is with, its newest message and when as its second line. */
export const textsItems = (r, now = new Date()) => (r?.conversations ?? []).map(x => ({
  document: {id: `texts:${x.id}`, title: x.name || 'Unknown', type: 'texts', source: 'messages', date: textsWhen(x.last?.at, now), url: x.url ?? null},
  reason: textsLine(x.last, !!x.group)}));

/** Where the desktop READMEs say how to give a device its bridge token (the state block's Set up). */
export const SETUP_URL = 'https://github.com/FloorLamp/spaceport/blob/main/deck/README.md#setting-up-a-machine';

/** How long a one-time code stays in Codes after it came (SPEC.md, *Codes*): the hosts drop it then too. */
export const CODE_MS = 15 * 60_000;
/** The codes still within CODE_MS at `now`, newest first (a host's codes.list or codes.changed list, anything odd left out). */
export const liveCodes = (list, now) => (Array.isArray(list) ? list : [])
  .filter(c => c && typeof c.id === 'string' && typeof c.code === 'string' && Number.isFinite(c.at) && now - c.at < CODE_MS)
  .map(c => ({id: c.id, code: c.code, from: typeof c.from === 'string' ? c.from : '', at: c.at}))
  .sort((a, b) => b.at - a.at);

/** A browse scope's key (the site's filtered browse, folded into the palette as a group): `browse:source=gmail&type=receipt&year=2024&sort=oldest`. */
export const browseKey = f => `browse:${new URLSearchParams(Object.entries(BROWSE).flatMap(([k]) => f?.[k] ? [[k, String(f[k])]] : [])).toString()}`;
const BROWSE = {source: 1, type: 1, year: 1, sort: 1};
/** A browse key's filters. */
export const browseOf = key => Object.fromEntries([...new URLSearchParams(String(key).replace(/^browse:/, ''))].filter(([k]) => BROWSE[k]));
/** A type as people read it: `tax-return` → `Tax return`. */
export const typeName = t => t ? String(t).replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()) : '';
/** A browse scope's title: `Seafile · Tax return · 2024 · oldest first` (`Everything` with no filter). */
/** window.popOut's `state` at most (the contract's maxLength). */
export const STATE_MAX = 1_000_000;
/** The page's view as window.popOut carries it (contract/shell.md, *Deck's own window*): JSON `{v: 1, palette, viewer?}`, `palette` the
 *  controller's snapshot, `viewer` the viewer's; past STATE_MAX the lean one (the query, the selection, what the viewer shows: the
 *  window asks bridge again), else null. */
export function viewState(palette, viewer = null) {
  const full = JSON.stringify({v: 1, palette, ...(viewer ? {viewer} : {})});
  if (full.length <= STATE_MAX) return full;
  const lean = JSON.stringify({v: 1, palette: {state: {query: palette.state.query, selected: palette.state.selected}, viewer: palette.viewer}});
  return lean.length <= STATE_MAX ? lean : null;
}
/** A view state back (env.get's `restore`, the `restore` event): `{palette, viewer}`, else null. */
export function parseViewState(text) {
  if (typeof text !== 'string' || text.length > STATE_MAX) return null;
  try {
    const s = JSON.parse(text);
    return s && s.v === 1 && s.palette && typeof s.palette === 'object' ? s : null;
  } catch { return null; }
}
const record = o => o && typeof o === 'object' && !Array.isArray(o) ? o : null;

export function browseTitle(f) {
  const parts = [f.source && model.sourceName(f.source), f.type && typeName(f.type), f.year, f.sort === 'oldest' ? 'oldest first' : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everything';
}

/** opts: `debounce` ms before bridge's find (100), `copiedMs` the ✓ before a shell hides (tokens motion.copied), `flashMs` a
 *  command chip's flash and an outcome shown before the panel hides (motion.flash), `picks` false to keep picks as they are
 *  (cases.json's runs: the model's own test records none), `onView({id, query, document} | {recent})` where a view opens elsewhere
 *  (the site: the document's page; default: `viewer`, the UI's own), `commands` false to show no transfer commands even where the
 *  host has transfers, `beforeHide()` a promise the panel's close motion settles before `window.hide`, `popOutState()` window.popOut's
 *  `state` (the page's view: viewState; default the palette's alone), `now`, `timers`. */
export function createController(host, {debounce = 100, copiedMs = 260, flashMs = 1600, picks: recordPicks = true, onView = null, onMap = null, commands = true, beforeHide = null,
  popOutState = null, now = () => Date.now(), timers = globalThis} = {}) {
  const authBlock = (error, backend = 'bridge') => {
    const f = describeFailure(backend, error, {device: host.kind === 'shell'});
    return {glyph: 'warn', title: 'Re-enroll this device', line: f.message, action: f.action, recoveryUrl: f.url, warn: true};
  };
  let state = model.initial();
  const env = {targets: [], actions: [], needs: [], codes: [], recent: [], found: {}, foundOrder: {}, answers: {}, groups: {}, picks: {}, commands: commands !== false && !!host.caps.transfers};
  const listeners = new Set(), work = new Set(), asks = new Set();
  let search = null; // {timer, skeleton, abort} of the pending find
  let lastFound = null; // the query whose found rows show last (kept while the next query's find runs)
  let copiedTimer = null, flashTimer = null, hideTimer = null, codesTimer = null;
  let inputAt = 0; // the person's last key or click in the page (c.input)
  // flightplan in the palette (SPEC.md, *Flightplan in Find*, *Capture*): where the host's registry has it, its lists (the find rules'
  // list names; asked once, retried a minute after a failure) and one Flightplan model (contract/flightplan.md) for the capture and the rows' writes
  const planOn = () => !!host.backends?.includes('flightplan');
  let fp = null, listsAsked = null, listsKnown = [], listsRetryAt = 0, findVersion = 0, toastSeen = null;
  const c = {
    host, env,
    peopleRelation: '',
    peopleRelations: [],
    people() { return /^people(?:\s|:|$)/i.test(state.query.trim()) && !state.scopes.length; },
    relation(value) {
      c.peopleRelation = value;
      for (const q of Object.keys(env.found)) if (/^people(?:\s|:|$)/i.test(q)) delete env.found[q];
      queryChanged();
      changed();
    },
    get state() { return state; },
    /** bridge's find for the query: {query, busy, error: {code, status, message} | null}. */
    find: {query: '', busy: false, error: null},
    /** the question being asked, else null; a group's fetch per key: {busy, error}. */
    asking: null, groups: {},
    /** A series group's chart per key (`series:<key>`, with the usage cap): {busy, data (contract/chart.md *Chart*, null: none), error}. */
    charts: {},
    /** the line under the rows: {kind: info | ok | bad | busy, text} or null (info: a pending confirmation or files waiting; busy: a
     *  transfer running). */
    status: null,
    codesError: null, targetsError: null, backgroundFailures: {},
    retryChart() { const key = state.scopes.at(-1)?.key; if (key) { delete c.charts[key]; loadChart(); } },
    retryList(kind) { return track((kind === 'codes' ? loadCodes() : loadTargets()).then(changed)); },
    /** A command chip's flash after its transfer went through (motion.flash): `pixel` (a target), `all`, `receive`, `share`; else null. */
    flash: null,
    /** A transfer the page runs (its commands wait meanwhile), else null. */
    transferring: null,
    /** Files waiting for a send (the shell's Send to: `files.pending`): {count, name}; else null. */
    files: null,
    /** The targets enrolled (devices.targets' `enrolled`), else null (all are): one not enrolled is dimmed and refused. */
    enrolled: null,
    /** what the viewer shows (P1): {id, query} or {recent}; null when closed. */
    viewer: null,
    /** the row a copy just put on the clipboard (its ✓ Copied), else null. */
    copied: null,
    /** env.get's answer: platform, mod, theme, highContrast, reduceMotion, bridgeSetUp, version. */
    platform: null,
    /** Recent's list answered once (before: placeholder rows, as many as `recentCount`); its failure. */
    recentLoaded: false, recentError: null, recentCount: 3,
    /** The browse scopes' choices (bridge.facets: {sources, types, years: [{v, n}]}), with the browse cap; else null. */
    facets: null,
    /** When bridge's last find answered (performance.now()), for the rows' paint time. */
    foundAt: 0,

    view: () => model.view(state, shown()),
    rows: () => model.rows(state, shown()),
    selected() { const e = shown(), list = model.rows(state, e), at = model.selection(state, e, list); return at >= 0 ? list[at] : null; },
    takes: k => model.takes(state, shown(), k),
    /** The env rows are drawn from: while a find runs, the previous query's found rows stay (SPEC.md, *States*: bridge searching). */
    shownEnv: () => shown(),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Every load the UI needs before it shows: the platform, picks, actions, what needs the owner, the codes, Recent, targets, the
     *  browse choices (each per the host's caps). */
    async start() {
      c.platform = await host.call('env.get', {}).catch(() => null);
      env.commands = commands !== false && !!host.caps.transfers;
      if (planOn()) env.capture = plan().capture;
      await Promise.all([planLists(), planOn() ? plan().resume() : null, loadRecentCount(), loadPicks(), loadActions(), loadNeeds(), loadCodes(), loadRecent(), loadTargets(), loadFacets()]);
      changed();
    },
    /** A key or a click by the person in the page (the view's, as it notes `ui.input`): an outcome shown for a hotkey stays. */
    input() { inputAt = now(); },
    /** The panel closes (the header's close): as the model's `close`. */
    close() { return hide(); },
    /** Deck in its own window (the header's pop out, Mod+Shift+O; window cap): the shell opens it (or brings it forward) on this
     *  view (`state`: what the panel shows), then the panel hides; a failure is the status line's. */
    async popOut() {
      if (!host.caps.window) return;
      let state = null;
      try { state = popOutState ? popOutState() : viewState(c.snapshot()); } catch { /* the window opens fresh */ }
      try { await host.call('window.popOut', state ? {state} : {}); } catch (e) { c.status = {kind: 'bad', text: describeFailure('This device', e).message}; changed(); return; }
      await hide().catch(() => {});
    },
    /** What the palette shows, as plain data for Deck's own window to open on (window.popOut's `state`): the model's state (query,
     *  selection, a focused chip, an answer, the open groups and scopes, never a pending confirmation), what its rows are drawn from
     *  (those queries' found rows and answers, the groups' rows and charts), the find's failure, an ask still running, what the viewer
     *  shows. Never the status, Recent or the lists (the window loads its own). */
    snapshot() {
      const queries = new Set([state.query, ...state.scopes.map(s => s.back?.query ?? '')].map(q => q.trim()).filter(Boolean));
      if (lastFound) queries.add(lastFound);
      for (const q of queries) if (healthQuery(q) != null) queries.delete(q);
      if (c.find.partial) queries.delete(c.find.query);
      const keys = state.scopes.map(s => s.key);
      const only = (o, ks, ok = () => true) => Object.fromEntries([...ks].filter(k => o[k] !== undefined && ok(o[k])).map(k => [k, o[k]]));
      return {state: {...state, answer: healthQuery(state.query) != null ? null : state.answer, confirm: null}, found: only(env.found, queries), answers: only(env.answers, queries), groups: only(env.groups, keys),
        charts: only(c.charts, keys, x => !x.busy), lastFound, find: {query: c.find.query, error: c.find.error}, asking: c.asking,
        ...(Object.keys(env.foundOrder).length ? {foundOrder: only(env.foundOrder, queries)} : {}),
        ...(c.peopleRelations.length || c.peopleRelation ? {peopleRelation: c.peopleRelation, peopleRelations: c.peopleRelations} : {}), viewer: c.viewer, viewerTarget: c.viewer ? c.viewerTarget ?? null : null};
    },
    /** A snapshot back (Deck's own window opening on the panel's view): its state and rows as they were; what was still loading asked
     *  again (the find, a group's rows, an ask). `quiet`: the listeners not told (the caller draws). */
    restore(s, {quiet = false} = {}) {
      s = record(s) ?? {};
      clear();
      const st = record(s.state) ?? {}, str = x => typeof x === 'string' ? x : null;
      const scopes = (Array.isArray(st.scopes) ? st.scopes : []).filter(x => typeof x?.key === 'string')
        .map(x => ({key: x.key, title: String(x.title ?? ''), rows: Array.isArray(x.rows) ? x.rows : null, back: record(x.back) ?? {}}));
      state = {...model.initial(), query: str(st.query) ?? '', selected: str(st.selected), chip: Number.isInteger(st.chip) ? st.chip : null, answer: record(st.answer), scopes};
      env.found = record(s.found) ?? {}; env.answers = record(s.answers) ?? {}; env.groups = record(s.groups) ?? {};
      env.foundOrder = record(s.foundOrder) ?? {};
      c.charts = record(s.charts) ?? {};
      c.viewer = record(s.viewer);
      c.viewerTarget = c.viewer ? record(s.viewerTarget) ?? c.viewer : null;
      c.peopleRelation = str(s.peopleRelation) ?? '';
      c.peopleRelations = (Array.isArray(s.peopleRelations) ? s.peopleRelations : []).filter(x => typeof x === 'string');
      const q = state.query.trim();
      lastFound = str(s.lastFound) && env.found[s.lastFound] ? s.lastFound : null;
      c.find = {query: q, busy: false, error: record(s.find)?.query === q ? record(s.find.error) : null};
      if (!scopes.length && q && !env.found[q] && !c.find.error) queryChanged();
      else if (env.found[q]) lastFound = q;
      for (const sc of scopes) if (sc.rows == null && !env.groups[sc.key]?.items) track(fetchGroup(sc.key));
      if (str(s.asking)) run({type: 'ask', query: s.asking});
      loadChart();
      if (!quiet) changed();
    },
    /** The status line done showing (an outcome faded): gone, unless another replaced it. */
    clearStatus(s) { if (c.status === s) { c.status = null; changed(); } },

    /** A model key (SPEC.md, *Keys*): the new state, then its effect as host ops. Answers the model's effect. */
    key(k) {
      const before = state, row = before.confirm ? null : c.selected();
      const [next, effect] = model.key(state, shown(), k);
      state = next;
      if (recordPicks && (k === 'Enter' || k === 'Mod+Enter') && row && PICKED.has(row.kind) && !textsRow(row) && !row?.result?.document?.health && (effect || state.confirm || state.scopes.length > before.scopes.length)) pick(row.id);
      if (state.confirm && !before.confirm) c.status = {kind: 'info', text: confirmText(state.confirm)};
      else if (!state.confirm && before.confirm) c.status = null;
      afterChange(before);
      track(run(effect, row));
      return effect;
    },
    /** The box's whole text (typing, a paste). */
    edit(text) {
      if (text === state.query) return;
      const before = state;
      state = model.edit(state, text);
      if (before.confirm) c.status = null;
      afterChange(before);
    },
    /** Open a group by key from elsewhere (the viewer's Related rail and chips: `day:<date>`, `cluster:<id>`, `subject:<name>`,
     *  `related:<doc id>:<kind>`), titled as the chip or rail named it; its rows are fetched. */
    openGroup(key, title) {
      if (title) env.groups = {...env.groups, [key]: {...env.groups[key], title, items: env.groups[key]?.items ?? []}};
      if (c.viewer) c.viewer = null;
      return c.key(`Group:${key}`);
    },
    /** Texts (Mod+T, the commands bar's Texts; texts cap): the owner's conversations, newest first, as a group over what was shown. */
    texts() {
      if (!host.caps.texts || c.platform?.bridgeSetUp === false || state.scopes.at(-1)?.key === TEXTS) return null;
      return c.openGroup(TEXTS, 'Texts');
    },
    /** The site's filtered browse as a group (owner decision 2026-10-13): {source, type, year, sort}; a browse already open is
     *  replaced (its filters changed), so Esc goes back to what was shown before browsing. */
    browse(filters = {}) {
      if (!host.caps.browse) return null;
      const f = Object.fromEntries(Object.entries(filters).filter(([k, v]) => BROWSE[k] && v));
      if (state.scopes.at(-1)?.key.startsWith('browse:')) state = model.key(state, env, 'Shift+Tab')[0];
      return c.openGroup(browseKey(f), browseTitle(f));
    },
    /** The open browse scope's filters, else null. */
    browsing() { const k = state.scopes.at(-1)?.key; return k?.startsWith('browse:') ? browseOf(k) : null; },
    /** The open series' or topic's group's chart: {busy, data, error}, else null (another scope, none asked). */
    chart() {
      const top = state.scopes.at(-1);
      if (!top || !host.caps.usage) return null;
      if (!top.key.startsWith('topic:')) return c.charts[top.key] ?? null;
      const t = Object.values(env.found).flat().find(r => r.kind === 'topic' && `topic:${r.topic?.key}` === top.key);
      return t?.topic.chart ? {busy: false, data: t.topic.chart, error: null} : null;
    },
    /** A chart's point opened (its `ref`, a document id): viewed as a found document is. */
    viewRef(id) { return run({type: 'view', id, query: ''}); },
    /** A click on a row. */
    select(id) {
      if (id === state.selected && !state.confirm) return;
      if (state.confirm) c.status = null;
      state = model.select(state, id);
      changed();
    },
    /** A double click (Android: a tap): the row selected, then Enter. */
    openRow(id) { c.select(id); return c.key('Enter'); },
    /** A click on a row's group affordance (`14 ›`, `+2 mails ›`, `n actions ›`) or a section's `All n ›` (its first row's): Tab on
     *  that row. */
    openGroupOf(id) { c.select(id); return c.key('Tab'); },
    /** A series chip clicked: Enter on that member (`i`, newest 0); the `+k` chip (`more`) focuses member `i` (the first past the
     *  window) without viewing. */
    chip(id, i, {more = false} = {}) {
      state = {...model.select(state, id), chip: i};
      changed();
      return more ? null : c.key('Enter');
    },
    /** A row's source chip (`Seafile ↗`): the document's page, as Mod+Enter on a document; the row is neither selected nor run. A
     *  link's chip: the document it came from. */
    source(id) {
      const row = c.rows().find(r => r.id === id);
      const docId = row?.kind === 'citation' ? row.citation.id : row?.result?.document?.id;
      if (docId == null) return Promise.resolve();
      return run({type: 'document', id: docId, file: false});
    },
    /** How many rows a section holds for the query (`All n ›`) when it shows fewer, else 0: `action` (House) or `recent`. */
    sectionMore(kind) {
      if (state.scopes.length || !['action', 'recent'].includes(kind)) return 0;
      const e = shown(), shownN = model.rows(state, e).filter(r => r.kind === kind).length;
      const key = kind === 'action' ? 'section:actions' : 'section:recent';
      const all = model.rows({...state, answer: null, scopes: [{key, title: '', rows: null, back: {}}]}, e).length;
      return all > shownN ? all : 0;
    },
    /** A section label's `Clear` (Recent): the clear confirmation, as Mod+Shift+Backspace. */
    clearRecent() { return c.key('Mod+Shift+Backspace'); },
    /** The right-click menu of a row (SPEC.md, *Keys*: the row's keys; Remove for a Recent item, model key `Remove`, its shortcut
     *  Mod+Backspace only while the box is empty: with text that key clears the box): [{id: model key, label, key?}]. */
    menuFor(id) {
      const s = model.select(state, id), e = shown(), list = model.rows(s, e), row = list.find(r => r.id === id);
      if (!row) return [];
      const keys = model.hint(s, e).filter(([k]) => k !== 'Esc').map(([key, label]) => ({id: key, label, key}));
      if (model.viewable(row) && !keys.some(k => k.id === 'Space') && row.kind === 'cluster') keys.unshift({id: 'Space', label: 'View', key: 'Space'});
      if (row.kind === 'recent' && host.caps.recent) keys.push({id: 'Remove', label: 'Remove', ...(state.query ? {} : {key: 'Mod+Backspace'})});
      return keys;
    },
    /** A menu item chosen: the row selected, then its key. */
    menuPick(id, key) { c.select(id); return c.key(key); },
    /** What dragging a row out gives (contract `drag.start`): Recent by its id, an identifier's or a link's text, a document's file by
     *  its id (a series: the focused or newest member); null when the row gives nothing. */
    dragOf(id) {
      const row = c.rows().find(r => r.id === id);
      const d = row?.result?.document;
      switch (row?.kind) {
        case 'recent': return {row: id, kind: 'recent', recent: row.item.id, ...(row.item.name ? {name: row.item.name} : {})};
        case 'identifier': case 'link': return {row: id, kind: row.kind, text: String(row.result.value), ...(d?.title ? {name: d.title} : {})};
        case 'document': return d?.id != null && !d.health && !textsRow(row) ? {row: id, kind: 'document', id: d.id, ...(d.title ? {name: d.title} : {})} : null;
        case 'citation': return {row: id, kind: 'document', id: row.citation.id, ...(row.citation.title ? {name: row.citation.title} : {})};
        case 'series': {
          const m = row.series.members[(state.selected === id ? state.chip : null) ?? 0] ?? row.series.members[0];
          return m ? {row: id, kind: 'document', id: m.id, ...(m.title ? {name: m.title} : {})} : null;
        }
      }
      return null;
    },
    /** The search box's placeholder (SPEC.md, *Layout*): what this host searches; in a group `Filter <title>`. */
    placeholder() {
      const top = state.scopes.at(-1);
      if (top) return `Filter ${top.title}`;
      // no bridge here (no token): what is left to search, and nothing to ask
      const bridge = c.platform?.bridgeSetUp !== false;
      const what = [bridge && env.actions.length ? 'actions' : null, bridge ? 'documents' : null, host.caps.recent ? 'Recent' : null, env.commands ? 'commands' : null].filter(Boolean);
      const list = what.length > 2 ? `${what.slice(0, -1).join(', ')}, ${what.at(-1)}` : what.join(' and ');
      return bridge ? `Search ${list} · end with ? to ask` : `Search ${list}`;
    },
    /** The commands bar shows (SPEC.md, *Layout*): transfers here, the empty query, no group, answer or viewer. */
    commandsBar() { return env.commands && !state.query.trim() && !state.scopes.length && !state.answer && !c.viewer; },
    /** The one state block in the rows' place (SPEC.md, *States*), else null: {glyph, title, line, action, warn}. The placeholder
     *  rows (Recent loading, a find with nothing yet, an ask, a group loading) are the view's, by `loading()`. */
    block() {
      if (c.viewer) return null;
      const list = c.rows(), q = state.query.trim(), top = state.scopes.at(-1);
      if (top) {
        const g = c.groups[top.key];
        if (g?.error?.status === 401 && !list.length) return authBlock(g.error);
        if (g?.error && !list.length && !env.groups[top.key]?.items?.length) return {glyph: 'warn', title: `Couldn’t load ${top.title}`, line: describeFailure('bridge', g.error).message, action: 'Retry', warn: true};
        if (list.length || g?.busy) return null;
        return q ? {glyph: 'find', title: `No matches for “${q}”`, line: `in ${top.title}`, action: null} : {glyph: 'document', title: `Nothing in ${top.title}`, line: '', action: null};
      }
      if (state.answer || c.asking) return null;
      if (!q) {
        if (!host.caps.recent || !c.recentLoaded || env.recent.length) return null;
        return c.recentError ? {glyph: 'warn', title: 'Couldn’t read Recent', line: describeFailure('This device’s Recent', c.recentError).message, action: 'Retry', warn: true}
          : {glyph: 'recent', title: 'Nothing here yet', line: 'Sends and receives show up here', action: null};
      }
      const backend = c.find.query === q && c.find.backend ? c.find.backend : healthQuery(q) != null ? 'allos' : spendingQuery(q) ? 'purser' : planOwns(q) ? 'flightplan' : 'bridge';
      if (backend === 'bridge' && (c.platform?.bridgeSetUp === false || c.find.error?.code === 'not-set-up')) return {glyph: 'document', title: 'bridge: not set up', line: describeFailure('bridge', {code: 'not-set-up'}).message, action: 'Set up'};
      const err = c.find.error;
      if (err?.status === 401 && c.find.query === q) return authBlock(err, backend);
      if (err && c.find.query === q) return {glyph: 'warn', title: 'Search unavailable', line: describeFailure(backend, err).message, action: 'Retry', warn: true};
      if (!list.length && !c.find.busy) return {glyph: 'find', title: `No matches for “${q}”`, line: '', action: 'Ask instead'};
      return null;
    },
    /** What loads where rows will be: `recent` (placeholder rows, as many as last time), `found` (FOUND · searching… with two
     *  placeholder rows while none show yet), `group` (an open group's first fetch), `ask`; else null. */
    loading() {
      if (c.viewer) return null;
      const top = state.scopes.at(-1);
      if (top) return c.groups[top.key]?.busy && !c.rows().length ? 'group' : null;
      if (c.asking && !state.answer) return 'ask';
      if (state.answer) return null;
      const q = state.query.trim();
      if (!q) return host.caps.recent && !c.recentLoaded ? 'recent' : null;
      return c.find.busy && c.find.skeleton && (!c.find.partial || !env.found[q]?.length) && c.find.query === q ? 'found' : null;
    },
    /** The block's action: Retry (Recent, the search, the group), Set up (the README), Ask instead (Shift+Enter). */
    blockAction() {
      const b = c.block();
      switch (b?.action) {
        case 'Ask instead': return c.key('Shift+Enter');
        case 'Re-enroll': return run({type: 'open', url: b.recoveryUrl});
        case 'Set up': return run({type: 'open', url: SETUP_URL});
        case 'Retry': {
          const top = state.scopes.at(-1);
          if (top) { const p = fetchGroup(top.key); track(p); return p; }
          if (!state.query.trim()) { const p = loadRecent().then(changed); track(p); return p; }
          delete env.found[state.query.trim()];
          queryChanged();
          changed();
          return c.idle();
        }
      }
      return null;
    },
    /** A fresh palette (on hide): no query, selection, answer, confirmation, results or viewer. */
    reset() { clear(); changed(); },
    closeViewer() { c.viewer = null; changed(); },
    /** Settles once nothing it started is still running (asks too with `asks`). */
    async idle({asks: withAsks = false} = {}) {
      for (;;) {
        const all = [...work, ...(withAsks ? asks : [])];
        if (!all.length) return;
        await Promise.allSettled(all);
      }
    },
  };

  function changed() { for (const fn of listeners) fn(c); }
  function clear() {
    cancelSearch();
    state = model.initial();
    c.peopleRelation = '';
    c.peopleRelations = [];
    for (const k of ['found', 'foundOrder', 'answers', 'groups']) env[k] = {};
    lastFound = null;
    for (const t of [copiedTimer, flashTimer, hideTimer]) timers.clearTimeout(t);
    Object.assign(c, {find: {query: '', busy: false, error: null}, asking: null, groups: {}, status: null, viewer: null, copied: null, flash: null, files: null});
    if (fp?.capture.text) fp.type('');
    pruneCodes();
  }
  /** env, with the previous query's found rows while this query's find runs (none of its own yet). */
  function shown() {
    const q = state.query.trim();
    if (healthQuery(q) != null || healthQuery(lastFound ?? '') != null || !c.find.busy || !q || env.found[q] || lastFound == null || !env.found[lastFound] || state.scopes.length) return env;
    return {...env, found: {...env.found, [q]: env.found[lastFound]}};
  }
  function track(p) { if (!p) return; work.add(p); p.finally(() => work.delete(p)); }
  const telemetry = (name, ok, t0, detail) => {
    if (!host.caps.telemetry) return;
    host.call('telemetry.event', {name, ok, ms: Math.max(0, Math.round(now() - t0)), ...(detail ? {detail} : {})}).catch(() => {});
  };
  const failure = e => { const h = hostError(e); return {code: h.code, ...(h.status ? {status: h.status} : {}), message: h.message}; };
  const outcome = e => e?.status ? `status:${e.status}` : undefined;

  function pick(id) {
    env.picks = {...env.picks, [id]: now()};
    if (host.caps.picks) host.call('picks.add', {id}).catch(() => {});
  }

  /** After a key or an edit: search bridge for a new query (outside groups; again for the query a closed group gives back). */
  function afterChange(before) {
    if (!state.scopes.length && (state.query !== before.query || before.scopes.length > 0)) queryChanged();
    loadChart();
    changed();
  }

  /** A series group just opened: its usage chart (bridge.usage of its first member), once per series, with the usage cap (a topic's
   *  comes with bridge's find: `topic.chart`). */
  function loadChart() {
    const top = state.scopes.at(-1);
    if (!host.caps.usage || !top || c.charts[top.key]) return;
    if (!top.key.startsWith('series:')) return;
    const doc = (top.rows ?? []).map(r => r.result?.document?.id).find(id => Number.isInteger(id));
    if (doc == null) return;
    const key = top.key;
    c.charts = {...c.charts, [key]: {busy: true, data: null, error: null}};
    track(host.call('bridge.usage', {doc}).then(
      r => { c.charts = {...c.charts, [key]: {busy: false, data: r?.series ?? null, error: null}}; changed(); },
      e => { c.charts = {...c.charts, [key]: {busy: false, data: null, error: failure(e)}}; changed(); }));
  }
  function cacheFound(q, rows) {
    env.found = {...env.found, [q]: rows};
    const keys = Object.keys(env.found);
    for (const key of keys.filter(key => key !== q).slice(0, Math.max(0, keys.length - 50))) {
      delete env.found[key];
      delete env.foundOrder[key];
    }
  }
  function cancelSearch() {
    findVersion++;
    if (c.find.partial) {
      delete env.found[c.find.query]; delete env.foundOrder[c.find.query];
      if (c.status?.text === 'Showing initial results · Couldn’t finish search') c.status = null;
    }
    if (!search) return;
    timers.clearTimeout(search.timer);
    timers.clearTimeout(search.skeleton);
    search.abort.abort();
    search.done();
    search = null;
  }
  /** The query's find after the pause (`again`: at once, its rows kept until the new ones come: after a flightplan write). `todo
   *  <text>` is flightplan's capture instead: its reading asked, no find. */
  function queryChanged({again = false} = {}) {
    cancelSearch();
    const q = state.query.trim(), text = planOn() && !state.scopes.length ? model.captureText(q) : null;
    if (fp && fp.capture.text.trim() !== (text ?? '')) fp.type(text ?? '');
    if (text != null) { c.find = {query: q, busy: false, error: null}; return; }
    if (!q || !again && env.found[q] && healthQuery(q) == null) { c.find = {query: q, busy: false, error: null}; if (env.found[q]) lastFound = q; return; }
    delete env.foundOrder[q];
    if (healthQuery(q) != null) delete env.found[q];
    c.find = {query: q, busy: true, error: null};
    const abort = new AbortController();
    let done;
    const p = new Promise(resolve => { done = resolve; });
    const timer = timers.setTimeout(() => runFind(q, abort.signal).finally(done), again ? 0 : debounce);
    const skeleton = timers.setTimeout(() => { if (!abort.signal.aborted) { c.find.skeleton = true; changed(); } }, debounce + 300);
    search = {timer, abort, done, skeleton};
    track(p);
  }
  async function runFind(q, signal) {
    const t0 = now(), version = findVersion;
    let bridgeRows, plan = [];
    const current = () => !signal.aborted && version === findVersion;
    let ruled = false;
    try {
      const health = healthQuery(q);
      let r;
      if (health != null) {
        if (!await healthIdentity(host)) { delete env.found[q]; delete env.answers[q]; throw new Error('Health is unavailable'); }
        r = await host.call('allos.find', {query: {q: health, limit: 20}}, {signal});
        r = {results: healthResults(r?.results ?? [])};
      } else if (c.people()) r = await host.call('bridge.people', {q: q.replace(/^people(?:\s*:\s*|\s+|$)/i, ''), relation: c.peopleRelation}, {signal});
      else if (spendingQuery(q)) r = await spendingResults(host, spendingQuery(q), {signal});
      else {
        // Deck's find rules answer from flightplan alone (no bridge or model call); else bridge's find, flightplan's matches beside it
        const on = planOn(), call = (op, args = {}) => host.call(`flightplan.${op}`, args, {signal});
        const lists = listsKnown, rule = on ? planQuery(q, lists) : null;
        if (rule) c.find.backend = 'flightplan';
        r = rule ? await planAnswer(call, rule, {now: now(), lists}) : null;
        ruled = !!r;
        if (!r) {
          delete c.find.backend;
          const bridge = host.call('bridge.find', {q, limit: 20, phase: 'words'}, {signal});
          if (on) track(planLists().then(lists => planSearch(call, q, {now: now(), lists})).catch(() => []).then(rows => {
            if (!current()) return;
            plan = rows;
            if (bridgeRows) {
              cacheFound(q, mergeFound(bridgeRows, plan));
              changed();
            }
          }));
          r = await bridge;
          bridgeRows = r?.results ?? [];
          r = {...r, results: mergeFound(bridgeRows, plan)};
        }
      }
      if (signal.aborted) return;
      if (c.people()) c.peopleRelations = [...new Set([...c.peopleRelations, ...(r?.results ?? []).map(r => r.person?.relation).filter(Boolean)])].sort();
      cacheFound(q, r?.results ?? []);
      const progressive = r?.progressive === 'two-phase-v1' && r.enrichment;
      if (progressive) {
        // Freeze the displayed order, including picks; the full answer is a replacement, never a patch.
        delete env.foundOrder[q];
        env.foundOrder[q] = model.rows(state, env).filter(x => x.result).map(x => x.id);
        c.find.partial = true;
        lastFound = q;
        c.foundAt = globalThis.performance?.now() ?? now();
        changed();
        const next = new URL(r.enrichment, 'https://bridge.invalid');
        if (!/^\/(v1|api)\/find$/.test(next.pathname) || next.origin !== 'https://bridge.invalid' || next.searchParams.get('q') !== q || next.searchParams.get('phase') !== 'full') throw new Error('Invalid Find enrichment');
        r = await host.call('bridge.find', {q, limit: Number(next.searchParams.get('limit') ?? 20), phase: 'full'}, {signal});
        if (signal.aborted) return;
        bridgeRows = r?.results ?? [];
        cacheFound(q, mergeFound(bridgeRows, plan));
      }
      c.find = {query: q, busy: false, error: null};
      lastFound = q;
      c.foundAt = globalThis.performance?.now() ?? now();
      // `rules:<n>`: answered by Deck's find rules, no bridge or model call (SPEC.md, *Telemetry*)
      telemetry('find', true, t0, `${ruled ? 'rules' : 'results'}:${env.found[q].length}`);
    } catch (e) {
      if (signal.aborted) return;
      const f = failure(e);
      if (f.code === 'cancelled') return;
      const partial = !!c.find.partial;
      bridgeRows = undefined;
      c.find = {query: q, busy: false, error: partial ? null : f, ...(partial ? {partial: true} : {}), ...(c.find.backend ? {backend: c.find.backend} : {})};
      if (partial) c.status = {kind: 'info', text: 'Showing initial results · Couldn’t finish search', retry: () => { queryChanged({again: true}); changed(); }};
      telemetry('find', false, t0, outcome(f));
    } finally {
      if (search?.abort.signal === signal) { timers.clearTimeout(search.skeleton); search = null; }
    }
    changed();
  }

  /** flightplan's lists (the find rules' list names), asked once; failures cool down for a minute. */
  function planLists() {
    if (!planOn()) return Promise.resolve([]);
    if (!listsAsked && now() < listsRetryAt) return Promise.resolve(listsKnown);
    listsAsked ??= host.call('flightplan.lists', {}).then(r => {
      listsKnown = Array.isArray(r?.lists) ? r.lists : [];
      if (fp) fp.lists = listsKnown;
      return listsKnown;
    }, () => { listsAsked = null; listsRetryAt = now() + 60_000; return listsKnown; });
    return listsAsked;
  }
  /** Whether flightplan answers the query here (a capture, a find rule). */
  const planOwns = q => planOn() && (model.captureText(q) != null || planQuery(q, listsKnown) != null);
  /** The palette's Flightplan model (flightplan.js, made once): the capture's reading and add, done and snooze; its writes find again,
   *  its toasts are the status line (with Undo). */
  function plan() {
    if (fp) return fp;
    const reload = () => { const q = state.query.trim(); if (q && !state.scopes.length && model.captureText(q) == null) queryChanged({again: true}); };
    fp = createFlightplan(host, {clock: now, timers, reload, page: 'find'});
    fp.lists = listsKnown;
    fp.subscribe(() => {
      env.capture = fp.capture;
      const t = fp.toast;
      if (t && t !== toastSeen) {
        toastSeen = t;
        c.status = {kind: t.bad ? 'bad' : t.signIn ? 'info' : 'ok', text: t.text, ...(t.undo ? {undo: () => { if (fp.toast === t) fp.dismiss(); c.status = null; changed(); const p = t.undo(); track(p); return p; }} : {}),
          ...(t.signIn ? {signIn: () => { if (fp.toast === t) fp.dismiss(); c.status = null; changed(); t.signIn(); }} : {})};
      }
      changed();
    });
    return fp;
  }
  /** A found flightplan item by id. */
  const planItem = id => Object.values(env.found).flat().find(r => r?.item?.id === id)?.item ?? null;

  async function loadPicks() {
    if (!host.caps.picks) return;
    const r = await host.call('picks.list', {}).catch(() => null);
    if (r?.picks) env.picks = {...r.picks, ...env.picks};
  }
  async function loadActions() {
    if (!host.caps.actions) return;
    try { env.actions = (await host.call('bridge.actions', {}))?.actions ?? []; delete c.backgroundFailures.actions; }
    catch (e) { c.backgroundFailures.actions = {backend: 'bridge', error: e, retry: () => track(loadActions().then(changed))}; }
  }
  const backendNeeds = new Map();
  /** What only the owner can fix (each configured backend, needs cap): the Needs you row while there are any; a failure keeps the last list. */
  async function loadNeeds() {
    if (!host.caps.needs) return;
    const backends = [...new Set([...(c.platform?.bridgeSetUp === false ? [] : ['bridge']), ...(host.backends ?? c.platform?.backends ?? [])])];
    await Promise.all(backends.map(async backend => {
      try { backendNeeds.set(backend, (await host.call(`${backend}.needs`, {}))?.needs ?? []); delete c.backgroundFailures[`${backend}.needs`]; }
      catch (e) { if (e?.code !== 'unsupported') c.backgroundFailures[`${backend}.needs`] = {backend, error: e, retry: () => track(loadNeeds().then(changed))}; }
    }));
    env.needs = mergeNeeds(backends.map(backend => [backend, backendNeeds.get(backend) ?? []]));
  }
  /** The desktops' one-time codes (codes cap; SPEC.md, *Codes*): the host's list, kept only in memory here as there. */
  async function loadCodes() {
    if (!host.caps.codes) return;
    try { setCodes((await host.call('codes.list', {}))?.codes); } catch (e) { c.codesError = failure(e); }
  }
  /** A codes list from the host: those still within CODE_MS, and a timer for the moment the oldest shown expires (then the rows
   *  go without a word from the host). */
  function setCodes(list) {
    c.codesError = null;
    env.codes = liveCodes(list, now());
    pruneCodes();
  }
  function pruneCodes() {
    timers.clearTimeout(codesTimer);
    codesTimer = null;
    const t = now();
    env.codes = env.codes.filter(x => t - x.at < CODE_MS);
    if (!env.codes.length) return;
    const next = Math.min(...env.codes.map(x => x.at + CODE_MS)) - t;
    codesTimer = timers.setTimeout(() => { pruneCodes(); changed(); }, Math.max(1, next));
  }
  async function loadRecent() {
    if (!host.caps.recent) return;
    try {
      env.recent = (await host.call('recent.list', {}))?.items ?? [];
      c.recentError = null;
      // the placeholders next time (the next start too: prefs `recentCount`), as many as the rows Recent shows now
      const n = Math.max(1, Math.min(8, env.recent.length));
      if (n !== c.recentCount) { c.recentCount = n; host.call('prefs.set', {key: 'recentCount', value: n}).catch(() => {}); }
    } catch (e) { c.recentError = failure(e); }
    c.recentLoaded = true;
  }
  async function loadRecentCount() {
    if (!host.caps.recent) return;
    const v = (await host.call('prefs.get', {key: 'recentCount'}).catch(() => null))?.value;
    if (!c.recentLoaded && Number.isInteger(v) && v >= 1 && v <= 8) { c.recentCount = v; changed(); }
  }
  async function loadFacets() {
    if (!host.caps.browse) return;
    try { c.facets = await host.call('bridge.facets', {}); } catch { c.facets = null; }
  }
  async function loadTargets() {
    if (!host.caps.transfers) return;
    try { setTargets(await host.call('devices.targets', {})); } catch (e) { c.targetsError = failure(e); }
  }
  function setTargets(r) {
    c.targetsError = null;
    env.targets = Array.isArray(r?.targets) ? r.targets.map(String) : [];
    c.enrolled = Array.isArray(r?.enrolled) ? r.enrolled : null;
  }

  /** What bridge gave about a document by id (a find result, a series member or alternate, an order's mail, a citation, a group's
   *  document), the one with a URL first; null when none. */
  function docOf(id) {
    const docs = [
      ...Object.values(env.found).flat().flatMap(r => [r.document, ...(r.series?.members ?? []).flatMap(m => [m, ...(m.alternates ?? [])]), ...(r.document?.mails ?? [])]),
      ...Object.values(env.answers).flatMap(a => a?.citations ?? []),
      ...Object.values(env.groups).flatMap(g => (g.items ?? []).map(i => i.document)),
    ].filter(d => d?.id === id);
    return docs.find(d => d.url) ?? docs[0] ?? null;
  }
  /** A browsed document (bridge's search answer) as rows take one: an order with its mails. */
  const browsed = d => ({id: d.id, title: d.title || String(d.sourceId ?? '').split('/').pop() || 'Untitled', type: d.type ?? null, date: d.date ?? null,
    period: d.period ?? null, source: d.source ?? null, url: d.url ?? null, ...(d.mails?.length ? {mails: d.mails.map(m => ({id: m.id, title: m.title, date: m.date, url: m.url ?? null}))} : {})});
  /** A document's own page, from what bridge gave; null: the host finds it. */
  const urlOf = id => openable(docOf(id)?.url ?? null);

  const confirmText = cf => ({share: 'Create a public link of the clipboard? Enter Create link · Esc Cancel', remove: 'Remove from Recent? Enter Remove · Esc Cancel',
    clear: 'Clear Recent? Enter Clear all · Esc Cancel', act: `${env.actions.find(a => a.id === cf.id)?.title ?? 'Run'}? Enter Run · Esc Cancel`})[cf.what];

  /** What the status says while files wait: `Send plan.pdf and 2 more: Ctrl+1–2 to one device, Ctrl+S to all`. */
  function filesLine(f) {
    const mod = c.platform?.mod === 'Meta' ? '⌘' : 'Ctrl+', n = Math.min(env.targets.length, 9);
    const what = `${f.name ?? (f.count === 1 ? 'a file' : `${f.count} files`)}${f.name && f.count > 1 ? ` and ${f.count - 1} more` : ''}`;
    return `Send ${what}: ${n ? `${mod}1${n > 1 ? `–${n}` : ''} to one device, ` : ''}${mod}S to all`;
  }

  /** A group's rows fetched into env.groups[key] (SPEC.md, *Groups*): a cluster's, a day's, a subject's or a Related group's. */
  async function fetchGroup(key) {
    const i = key.indexOf(':'), kind = key.slice(0, i), value = key.slice(i + 1);
    const docs = r => (r?.documents ?? []).map(document => ({document}));
    const [op, args, items] = {
      browse: ['bridge.browse', browseOf(key), r => (r?.results ?? []).map(d => ({document: browsed(d)}))],
      person: ['bridge.pages', {id: Number(value)}, r => model.personRows(r.person, {id: Number(value)})],
      cluster: ['bridge.cluster', {id: value}, docs],
      day: ['bridge.day', {date: value}, docs],
      subject: ['bridge.subject', {name: value}, docs],
      texts: ['bridge.texts', {limit: 100}, r => textsItems(r, new Date(now()))],
      related: ['bridge.related', {id: Number(value.slice(0, value.indexOf(':'))), kinds: [value.slice(value.indexOf(':') + 1)], limit: 50},
        r => (r?.groups ?? []).flatMap(g => g.items ?? []).map(({document, reason}) => ({document, ...(reason ? {reason} : {})}))],
    }[kind] ?? [];
    if (!op) return;
    const title = env.groups[key]?.title ?? state.scopes.find(s => s.key === key)?.title ?? value;
    c.groups = {...c.groups, [key]: {busy: true, error: null}};
    changed();
    const t0 = now();
    try {
      const got = items(await host.call(op, args));
      if (kind === 'person') state.scopes = state.scopes.map(s => s.key === key ? {...s, rows: got} : s);
      env.groups = {...env.groups, [key]: {title, items: kind === 'person' ? [] : got}};
      c.groups = {...c.groups, [key]: {busy: false, error: null}};
      telemetry('group', true, t0, `results:${got.length}`);
    } catch (e) {
      const f = failure(e);
      c.groups = {...c.groups, [key]: {busy: false, error: f}};
      telemetry('group', false, t0, outcome(f));
    }
    changed();
  }

  async function ask(q) {
    c.asking = q;
    changed();
    const t0 = now();
    try {
      const health = healthQuery(q);
      let answer;
      if (health != null) {
        if (!await healthIdentity(host)) { delete env.found[q]; delete env.answers[q]; throw new Error('Health is unavailable'); }
        const r = await host.call('allos.ask', {query: {q: health}});
        answer = {answer: [r.answer, r.offline ? describeFailure('allos record Q&A', {code: 'unreachable'}).message : '', ...(r.citations ?? []).map(c => `[${c.index}] ${c.title} · ${c.subtitle ?? ''} · ${c.date ?? ''}`)].filter(Boolean).join('\n'), citations: []};
      } else answer = await lookupAnswer(host, q) ?? await host.call('bridge.ask', {q});
      env.answers = {...env.answers, [q]: answer};
      telemetry('ask', true, t0);
      c.asking = null;
      if (state.query.trim() === q && !state.scopes.length) { c.key('Answer'); return; }
    } catch (e) {
      const f = failure(e);
      c.status = {kind: 'bad', text: describeFailure(healthQuery(q) != null ? 'allos' : spendingQuery(q) ? 'purser' : 'bridge', f).message, retry: () => track(ask(q))};
      telemetry('ask', false, t0, outcome(f));
    }
    c.asking = null;
    changed();
  }

  /** Which command chip a transfer flashes: the target sent to, `all`, `receive`, `share`. */
  const chipOf = (op, to) => op === 'transfer.send' ? (to?.length === 1 ? to[0] : 'all') : op === 'transfer.receive' ? 'receive' : 'share';
  const BUSY = {'transfer.send': to => to?.length === 1 ? `Sending to ${to[0]}…` : 'Sending to every device…', 'transfer.receive': () => 'Receiving…', 'transfer.share': () => 'Creating a public link…'};
  /** A chip flashes ok for motion.flash. */
  function flash(chip) {
    c.flash = chip;
    timers.clearTimeout(flashTimer);
    flashTimer = timers.setTimeout(() => { c.flash = null; changed(); }, flashMs);
  }

  async function transfer(op, args) {
    // a configured target not enrolled: refused here (its chip is dimmed)
    if (op === 'transfer.send' && c.enrolled && args.to?.length === 1 && !c.enrolled.includes(args.to[0])) {
      c.status = {kind: 'bad', text: `${args.to[0]}: not set up. Not retrying automatically. Enroll the device in Settings.`};
      changed();
      return;
    }
    if (c.transferring) return;
    const t0 = now();
    c.transferring = op;
    c.status = {kind: 'busy', text: BUSY[op](args.to)};
    changed();
    try {
      const r = await host.call(op, args);
      c.status = {kind: 'ok', text: r?.message ?? ''};
      flash(chipOf(op, args.to));
      if (op === 'transfer.send') c.files = null;
      telemetry('transfer', true, t0);
      if (op !== 'transfer.share') await loadRecent();
      if (op === 'transfer.receive' && r?.item && !state.query.trim() && !state.answer && !state.scopes.length) state = model.select(state, `recent:${r.item}`);
    } catch (e) {
      c.status = {kind: 'bad', text: describeFailure('Hangar', e).message, retry: () => track(transfer(op, args))};
      telemetry('transfer', false, t0);
    } finally {
      c.transferring = null;
    }
    changed();
  }

  /** The panel hides (window cap): the close motion first (beforeHide), then `window.hide`. */
  async function hide(args = {}) {
    if (!host.caps.window) return;
    await beforeHide?.();
    await host.call('window.hide', args);
  }

  async function copied(rowId) {
    c.copied = rowId;
    changed();
    timers.clearTimeout(copiedTimer);
    if (!host.caps.window) { copiedTimer = timers.setTimeout(() => { c.copied = null; changed(); }, 1200); return; }
    await new Promise(resolve => timers.setTimeout(resolve, copiedMs));
    await hide();
  }

  /** Something opened outside (a page, a link, the map): the panel hides so it shows (contract/shell.md, *Who sizes and hides the panel*). */
  const opened = () => host.caps.window ? hide({reason: 'opened'}).catch(() => {}) : null;

  /** An effect (SPEC.md, *Actions (model effects)*) as host ops; a failure is the status line's. */
  async function run(e, row = null) {
    if (!e) return;
    const rowId = c.selected()?.id ?? null;
    try {
      switch (e.type) {
        case 'view': {
          const target = healthKey(e.id) != null ? {health: {key: healthKey(e.id)}, title: docOf(e.id)?.title} : e.recent != null ? {recent: env.recent.find(i => i.id === e.recent) ?? e.recent} : {id: e.id, query: e.query, ...(docOf(e.id) ? {document: docOf(e.id)} : {})};
          if (onView) return void await onView(target);
          c.viewer = target.health ? target : e.recent != null ? {recent: e.recent} : {id: e.id, query: e.query};
          c.viewerTarget = target;
          changed();
          return;
        }
        // an identifier's Mod+Enter: bridge's page of the document it was read from (the host finds it), never another row's URL
        case 'document':
          if (healthKey(e.id) != null) return run({type: 'view', id: e.id, query: ''}, row);
          // a Texts conversation's page: Google Messages' own (bridge has no page of it)
          if (String(e.id).startsWith('texts:')) { const url = urlOf(e.id); if (url) await host.call('url.open', {url}); return opened(); }
          await (e.file ? host.call('document.open', {id: e.id}) : host.call('document.page', {id: e.id, url: row?.kind === 'identifier' ? null : urlOf(e.id)})); return opened();
        case 'copy': await host.call('clipboard.copy', {text: String(e.value), sensitive: !!e.sensitive}); return copied(rowId);
        case 'copyRecent': await host.call('recent.copy', {id: e.id}); return copied(rowId);
        // a one-time code: the host copies it from its own memory (sensitive); one it no longer holds is gone from the rows too
        case 'copyCode':
          try { await host.call('codes.copy', {id: e.id}); }
          catch (err) { if (hostError(err).code === 'refused') { env.codes = env.codes.filter(x => x.id !== e.id); pruneCodes(); } throw err; }
          return copied(rowId);
        case 'open': await host.call('url.open', {url: e.url}); return opened();
        case 'reveal': await host.call('recent.reveal', {id: e.id}); return opened();
        case 'map': if (onMap) return onMap({by: e.by, value: String(e.value)}); await host.call('map.open', {by: e.by, value: String(e.value)}); return opened();
        case 'group': return fetchGroup(e.key);
        case 'act': {
          const r = await host.call('bridge.act', {id: e.id});
          c.status = {kind: 'ok', text: `${r?.title ?? e.id}: ${r?.state ?? 'done'}`};
          await loadActions();
          changed();
          return;
        }
        // a need's `op` action: the backend does it (bridge.need), then the list again
        case 'need': {
          const r = await host.call(`${e.backend ?? 'bridge'}.need`, {id: e.id});
          c.status = {kind: 'ok', text: r?.message ?? 'Done'};
          await loadNeeds();
          changed();
          return;
        }
        case 'ask': { const p = ask(e.query); asks.add(p); p.finally(() => asks.delete(p)); return; }
        // flightplan (SPEC.md, *Flightplan in Find*, *Capture*): the model's writes, each with its toast's Undo on the status line
        case 'done': { const item = planItem(e.id); if (item) await plan().done(item); return; }
        case 'snooze': {
          if (state.scopes.at(-1)?.key === `snooze:${e.id}`) { state = model.key(state, shown(), 'Shift+Tab')[0]; changed(); }
          const item = planItem(e.id);
          if (item) await plan().snooze(item, {until: e.until});
          return;
        }
        case 'capture': {
          const f = plan();
          if (f.capture.text.trim() !== e.text) f.type(e.text);
          if (await f.add(e.choice ?? null) && model.captureText(state.query.trim()) === e.text) { const before = state; state = model.edit(state, ''); afterChange(before); }
          return;
        }
        case 'send': return transfer('transfer.send', {to: e.to});
        case 'receive': return transfer('transfer.receive', {});
        case 'share': return transfer('transfer.share', {});
        case 'remove': await host.call('recent.remove', {id: e.id}); await loadRecent(); changed(); return;
        case 'clear': await host.call('recent.clear', {}); c.status = {kind: 'ok', text: 'Recent items cleared'}; await loadRecent(); changed(); return;
        case 'close': return hide();
      }
    } catch (err) {
      c.status = {kind: 'bad', text: describeFailure(e.type === 'act' ? 'bridge' : 'This device', err).message, retry: () => track(run(e))};
      changed();
    }
  }

  // the host's events (contract/shell.md, *Events*)
  host.on('actions.changed', () => track(loadActions().then(changed)));
  host.on('recent.changed', () => track(loadRecent().then(changed)));
  // a one-time code came or expired (the desktops): the list with the event, else asked
  host.on('codes.changed', d => { if (Array.isArray(d?.codes)) { setCodes(d.codes); changed(); } else track(loadCodes().then(changed)); });
  // a device enrolled or removed: the commands bar's targets without a restart
  host.on('targets.changed', d => { if (Array.isArray(d?.targets)) { setTargets(d); changed(); } else track(loadTargets().then(changed)); });
  // a pushed or hotkey transfer (the shell runs it): `busy` while it runs, then its outcome, its chip's flash, an item it brought
  // selected on an empty query (as a receive's); `hide`: the panel opened only for this, so it hides after motion.flash when it went
  // through and the person did nothing here meanwhile
  host.on('transfer', d => {
    if (d?.busy) { c.status = {kind: 'busy', text: d.message ?? ''}; changed(); return; }
    const ok = d?.ok !== false;
    c.status = {kind: ok ? 'ok' : 'bad', text: ok ? d?.message ?? '' : describeFailure('Hangar', d?.error ?? {code: 'http'}).message};
    if (ok && d?.op) flash(chipOf(`transfer.${d.op}`, d.to ?? null));
    if (ok && d?.op === 'send') c.files = null;
    if (ok && d?.hide && host.caps.window) {
      const at = now();
      timers.clearTimeout(hideTimer);
      hideTimer = timers.setTimeout(() => { if (inputAt <= at) track(hide().catch(() => {})); }, flashMs);
    }
    changed();
    track(loadRecent().then(() => { if (d?.item && !state.query.trim() && !state.answer && !state.scopes.length) state = model.select(state, `recent:${d.item}`); changed(); }));
  });
  // files waiting for a send (Send to → Deck): the next send takes them; the status says how
  host.on('files.pending', d => {
    const n = Number(d?.count) || 0;
    const was = c.files;
    c.files = n > 0 ? {count: n, name: typeof d?.name === 'string' ? d.name : null} : null;
    if (c.files) c.status = {kind: 'info', text: filesLine(c.files)};
    else if (was && c.status?.kind === 'info' && c.status.text === filesLine(was)) c.status = null;
    changed();
  });
  // shown: what needs the owner read again; a hotkey's share asks its confirmation at once (as Mod+P)
  host.on('show', d => { track(loadNeeds().then(changed)); if (d?.reason === 'share' && env.commands) c.key('Mod+P'); });
  host.on('hide', () => c.reset());
  host.on('theme', d => { c.platform = {...c.platform, ...d}; changed(); });
  host.on('link', d => {
    if (d?.find != null) { c.reset(); c.edit(String(d.find)); }
    else if (d?.ask != null) { c.reset(); c.edit(String(d.ask)); c.key('Shift+Enter'); }
    else if (d?.act != null) {
      // selected inside the House group, never run (a web page must not unlock a door); one not listed: the status says so
      c.reset();
      if (!env.actions.some(a => a.id === String(d.act))) { c.status = {kind: 'bad', text: describeFailure('bridge house actions', {status: 404}).message}; changed(); return; }
      state = model.select(state, 'house');
      c.key('Enter');
      c.select(`action:${d.act}`);
    } else if (d?.recent != null) {
      // a notification's click (deck://recent?id=): that Recent item selected on the empty query
      c.reset();
      c.select(`recent:${d.recent}`);
    }
  });
  return c;
}
