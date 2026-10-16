// The palette's model, the executable form of SPEC.md: which rows a query shows, which one is selected, what each key does and the
// hint line. Pure: no I/O. Windows (desktop/windows), the Mac (desktop/mac) and Android implement the same and pass cases.json; this
// one passes it in npm test (test/palette.test.mjs).

export const MAX = {found: 8, recent: 5, commands: 4, actions: 5, codes: 5};

export const isQuestion = q => { const t = q.trim(); return t.length > 1 && t.endsWith('?'); };
const words = q => q.toLowerCase().split(/\s+/).map(w => w.replace(/[?!.,;:]+$/, '')).filter(Boolean);

/** Edits (insert, delete, substitute, swap two neighbours) turning a into b: the optimal string alignment distance. */
export function distance(a, b) {
  const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** A typed word reaches a word when it starts it, or (4 characters on, not all digits: `2023` never reaches `2024`) when one typo
 *  away from the word's start of about its length. */
export const near = (t, w) => t.startsWith(w) || (w.length >= 4 && !/^\d+$/.test(w) && [w.length - 1, w.length, w.length + 1].some(n => n <= t.length && distance(t.slice(0, n), w) <= 1));

/** Rows picked before first, the latest pick first; the rest keep their order. picks: {row id: when (ms)}. */
const byPicks = (list, picks = {}) => [...list.filter(r => picks[r.id]).sort((a, b) => picks[b.id] - picks[a.id]), ...list.filter(r => !picks[r.id])];

/** Every command, in order: send to each target, to all, receive, public link. */
export function commands(targets) {
  return [
    ...targets.map((t, i) => ({kind: 'command', id: `send:${t}`, title: `Send to ${t}`, key: i < 9 ? `Mod+${i + 1}` : null, effect: {type: 'send', to: [t]}})),
    {kind: 'command', id: 'send:all', title: 'Send to all devices', key: 'Mod+S', effect: {type: 'send', to: null}},
    {kind: 'command', id: 'receive', title: 'Receive', key: 'Mod+R', effect: {type: 'receive'}},
    {kind: 'command', id: 'share', title: 'Create public link', key: 'Mod+P', effect: {type: 'confirm', what: 'share'}},
  ];
}

/** A recent item as a row; its id `recent:<item id>`. */
function recentRow(item) {
  return {kind: 'recent', id: `recent:${item.id}`, item};
}

/** bridge's rows that say something rather than find it: `answer` (a fact answering the query), `none` (nothing about it, no such
 *  year's document, passwords are elsewhere); each views its `document` when it has one. */
const NOTES = new Set(['answer', 'none']);
const noted = row => NOTES.has(row?.kind) && !!row.result.document;

/** A found result (bridge's find) as a row: identifiers and links by value, documents by id; a document carrying `series` is the
 *  series' row; a utility topic (`topic`: its accounts' usage as one chart) its own, as an area of the home (`area`: its projects and
 *  services), a thing (`thing`: a device or plant of the house), a person (`person`), a trip (`trip`) and the more trips (`trips`: the
 *  trips past bridge's first four). */
function foundRow(r) {
  if (r.kind === 'thing') return {kind: 'thing', id: `thing:${r.thing.id}`, result: r, thing: r.thing};
  if (['person', 'trip', 'event'].includes(r.kind) && r[r.kind]) return {kind: r.kind, id: `${r.kind}:${r[r.kind].id}`, result: r, [r.kind]: r[r.kind]};
  if (r.kind === 'day') return {kind: 'day', id: `day:${r.day.date}`, result: r, day: r.day};
  if (r.kind === 'topic') return {kind: 'topic', id: `topic:${r.topic.key}`, result: r, topic: r.topic};
  if (r.kind === 'area') return {kind: 'area', id: `area:${r.area.key}`, result: r, area: r.area};
  if (r.kind === 'trips' && r.trips) return {kind: 'trips', id: `trips:${r.trips.key}`, result: r, trips: r.trips};
  if (r.kind === 'document' && r.series) return {kind: 'series', id: `series:${r.series.key}`, result: r, series: r.series};
  if (r.kind === 'project') return {kind: 'project', id: `project:${r.project.id}`, result: r, project: r.project};
  // bridge's answer and none rows (a stored fact answering the query; a line saying what is not there) by their title
  const id = r.kind === 'document' ? `doc:${r.document.id}` : NOTES.has(r.kind) ? `${r.kind}:${r.title}` : `${r.kind}:${r.value}`;
  return {kind: r.kind, id, result: r};
}

/** Bridge's results with each series collapsed: the document carrying `series` stays (as the series' row), its other members'
 *  documents and their alternates go, wherever they are (SPEC.md, *Series*). */
export function collapse(results) {
  const members = new Set(results.flatMap(r => r.kind === 'document' && r.series
    ? r.series.members.flatMap(m => [m.id, ...(m.alternates ?? []).map(a => a.id)]) : []));
  return results.filter(r => r.kind !== 'document' || r.series || !members.has(r.document?.id));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A period as a chip shows it: `2025`, `Mar 2025` (a month), else as given. */
export const periodLabel = p => { const m = /^(\d{4})-(\d{2})$/.exec(p ?? ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : p ?? ''; };

/** A date as rows show it: `Apr 10, 2025` (a day), `Apr 2025` (a month), `2025` (a year); anything else as given. */
export const dateLabel = d => {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(d ?? '');
  if (!m) return d ?? '';
  return m[3] ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
};

/** The span of periods or dates (`2012–2025`, `Jul–Sep 2025`, `Nov 2024–Jan 2025`, `2025`); days count by their month. */
export function span(first, last) {
  const month = p => /^\d{4}-\d{2}/.test(p ?? '') ? p.slice(0, 7) : p;
  [first, last] = [month(first), month(last)];
  if (!first) return '';
  if (first === last) return periodLabel(first);
  const [a, b] = [periodLabel(first), periodLabel(last)];
  return /^\d{4}-\d{2}$/.test(first) && first.slice(0, 4) === last.slice(0, 4) ? `${a.slice(0, 3)}–${b}` : `${a}–${b}`;
}

/** A series row's lines and chips: title `series.title`; subtitle the span of its periods and its count (`2012–2025 · 14`,
 *  `Jul–Sep 2025 · 3`); a chip per member, newest first (`{id, label}`; a member without a period: its title). */
export function seriesLines(series) {
  const periods = series.members.map(m => m.period).filter(Boolean).sort();
  const range = span(periods[0], periods.at(-1));
  const count = series.count ?? series.members.length;
  return {title: series.title, subtitle: range ? `${range} · ${count}` : `${count}`,
    chips: series.members.map(m => ({id: m.id, label: m.period ? periodLabel(m.period) : m.title}))};
}

const KINDS = {home: 'Home', purchase: 'Purchase', vehicle: 'Vehicle', travel: 'Travel', move: 'Move', legal: 'Legal', tax: 'Tax',
  finance: 'Finance', health: 'Health', family: 'Family', work: 'Work', event: 'Event', other: 'Project'};
/** A project row's lines (bridge's find kind `project`): its name over kind · span · count (`Home · Apr–Jul 2025 · 23`). */
export function projectLines(project) {
  return {title: project.name, subtitle: [KINDS[project.kind] ?? 'Project', span(project.from, project.to), project.count].filter(v => v != null && v !== '').join(' · ')};
}

/** A document's second line: its type over the period it covers (a year or month), else its date (`tax return · 2024`,
 *  `mail · May 2, 2025`); a Related item's or a group member's `reason` in place of the type when given. An order (bridge's
 *  `document.order`) its merchant, month, total and status past ordered (`Amazon · Mar 2025 · $99.92`). The source is the chip's. */
export function docSubtitle(document, reason = null) {
  const o = document.order;
  if (o) return [o.merchant, o.date ? periodLabel(String(o.date).slice(0, 7)) : null, o.total, o.status && o.status !== 'ordered' ? o.status : null].filter(Boolean).join(' · ');
  const p = document.period, when = /^\d{4}(-\d{2})?$/.test(p ?? '') ? periodLabel(p) : dateLabel(document.date ?? p);
  return [reason ?? document.type, when].filter(Boolean).join(' · ');
}

/** The chips a row has room for: `slots` chips' room (the platform measures it; `+k` takes one). All of them when they fit; else
 *  slots − 1 of them, a window starting at the newest that moves to keep the focused chip in it, then `+k`, k the chips not shown. */
export function fitChips(labels, slots, focus = null) {
  if (labels.length <= slots) return labels;
  const room = Math.max(slots - 1, 0), start = focus == null || focus < room ? 0 : focus - room + 1;
  return [...labels.slice(start, start + room), `+${labels.length - room}`];
}

/** A document's glyph (SPEC.md, *Glyphs*: each app's icon for each name), by its source, then words of its type; else `document`. */
const GLYPHS = [[/mail|message$/, 'mail'], [/photo|image|screenshot/, 'photo'], [/video|movie/, 'video'], [/invoice|receipt|bill/, 'receipt'],
  [/order/, 'order'], [/contract|agreement|lease|deed/, 'contract'], [/statement/, 'statement'], [/tax|w-2|1099|1098|return/, 'form'],
  [/passport|licen[cs]e|\bid\b|card/, 'id'], [/spreadsheet|csv|table/, 'table'], [/presentation|slides/, 'slides'], [/zip|archive/, 'archive']];
export function docGlyph(document) {
  const source = String(document?.source ?? '').toLowerCase(), type = String(document?.type ?? '').toLowerCase();
  if (source === 'messages') return 'chat';
  if (source === 'immich') return /video/.test(type) ? 'video' : 'photo';
  const hit = GLYPHS.find(([re]) => re.test(type));
  if (hit) return hit[1];
  return {kb: 'note', house: 'house', 'house-model': 'house', ref: 'key'}[source] ?? 'document';
}

/** A house action as a row; its id `action:<action id>`. env.actions comes most recently used first (by a person: SPEC.md, *Actions*). */
function actionRow(a) {
  return {kind: 'action', id: `action:${a.id}`, action: a};
}

/** The House row: every action as one collapsed row at the end of the empty query, `count` of them; it opens them as a group (Tab,
 *  →, Enter) and never runs one (SPEC.md, *Rows*). */
const houseRow = n => ({kind: 'house', id: 'house', count: n});

/** The Needs you row: what only the owner can fix to keep the backends' data flowing (env.needs: each backend's `GET /v1/needs`, spaceport
 *  shared/backend/README.md), `count` of them, first on the empty query while there are any; it opens them as the Needs you group (Tab, →,
 *  Enter). A need as a row, its id `need:<need id>`. */
const needsRow = n => ({kind: 'needs', id: 'needs', count: n});
const needRow = n => ({kind: 'need', id: `need:${n.backend && n.backend !== 'bridge' ? `${n.backend}/` : ''}${n.id}`, need: n});
const needText = n => [n.title, n.detail, n.backend, n.source, n.action?.label, n.action?.command].filter(Boolean).join(' ');

/** A one-time code as a row (env.codes: the desktops' codes.list, the last 15 minutes' codes, newest first; SPEC.md, *Codes*), its id
 *  `code:<code id>`; the empty query's first rows, at most MAX.codes. Enter copies it (effect `copyCode`), nothing opens or views it. */
const codeRow = c => ({kind: 'code', id: `code:${c.id}`, code: c});

/** What a recent item is searched by: its preview, name, link and peers. */
const recentText = i => [i.preview, i.name, i.link, ...(i.peers ?? [])].filter(Boolean).join(' ').toLowerCase();
/** An action matches when every word starts (or nearly starts) a word of its title or subtitle. */
const actionMatch = (ws, a) => ws.every(w => words(`${a.title} ${a.subtitle ?? ''}`).some(t => near(t, w)));
/** A Recent item, a group's member: every word is in its text or nearly starts one of its words. */
const textMatch = (ws, text) => { const t = text.toLowerCase(), tw = words(t); return ws.every(w => t.includes(w) || tw.some(x => near(x, w))); };

/** A document as a group's row (a series member or alternate, an order's mail, a project's, a day's, a subject's or a Related
 *  group's document): a document row, with the `reason` it is there or the period it is an `alternateOf`. */
function memberRow(document, extra = {}) {
  return {kind: 'document', id: `doc:${document.id}`, result: {kind: 'document', title: document.title, document}, ...extra};
}

/** The group a row holds (SPEC.md, *Groups*), else null: `{key, title}` and `rows` (inline: a series' members and their alternates,
 *  an order and its mails, numbers and links, a thing's documents), `load` (the app fetches env.groups[key]: a project), or `carry` (a section: the query goes along). */
export function groupOf(row) {
  switch (row?.kind) {
    case 'series': {
      const type = row.result.document.type;
      return {key: `series:${row.series.key}`, title: row.series.title, rows: row.series.members.flatMap(m => [
        memberRow({id: m.id, title: m.title, type, period: m.period, source: m.source, url: m.url}),
        ...(m.alternates ?? []).map(a => memberRow({id: a.id, title: a.title, type, period: m.period, source: a.source, url: a.url},
          {alternateOf: m.period ? periodLabel(m.period) : m.title}))])};
    }
    case 'project': return {key: `project:${row.project.id}`, title: row.project.name, load: true};
    case 'topic': return {key: `topic:${row.topic.key}`, title: row.topic.title, rows: (row.topic.results ?? []).map(foundRow)};
    case 'area': return {key: `area:${row.area.key}`, title: row.area.title, rows: (row.area.results ?? []).map(foundRow)};
    case 'trips': return {key: `trips:${row.trips.key}`, title: row.trips.title, rows: (row.trips.results ?? []).map(foundRow)};
    // a count bridge answered (an answer carrying `tally`: how many times we ordered from a store): what it counted, its orders
    case 'answer': return row.result.tally ? {key: `tally:${row.result.tally.key}`, title: row.result.tally.title, rows: (row.result.tally.results ?? []).map(foundRow)} : null;
    case 'day': return {key: `day:${row.day.date}`, title: row.result.title, rows: (row.day.results ?? []).map(foundRow)};
    case 'event': return {key: `event:${row.event.id}`, title: row.result.title, rows: [
      ...(row.event.attendees ?? []).map(a => foundRow(a.document ? a : {kind: 'none', title: [a.name, a.email].filter(Boolean).join(' · ')})),
      ...(row.event.documents ?? []).map(foundRow)]};
    case 'thing': return {key: `thing:${row.thing.id}`, title: row.thing.name ?? row.result.title,
      rows: (row.thing.documents ?? []).map(d => memberRow(d, d.reason ? {reason: d.reason} : {}))};
    // a person's phone and email, a trip's confirmation numbers (identifier rows of its view document), then its documents
    case 'person': case 'trip': {
      const e = row[row.kind], d = row.result.document;
      return {key: `${row.kind}:${e.id}`, title: row.result.title || e.name, rows: [
        ...(e.ids ?? []).map(x => ({kind: 'identifier', id: `identifier:${x.value}`, result: {kind: 'identifier', title: x.title, value: x.value, document: d}})),
        ...(e.documents ?? []).map(m => memberRow(m, m.reason ? {reason: m.reason} : {}))]};
    }
    case 'document': {
      const d = row.result.document, o = d.order;
      return d.mails?.length || o?.links?.length || o?.ids?.length ? {key: `order:${d.id}`, title: d.title,
        rows: [memberRow(d), ...(d.mails ?? []).map(m => memberRow({type: 'mail', source: 'gmail', ...m})),
          ...(o?.ids ?? []).map(x => ({kind: 'identifier', id: `identifier:${x.value}`, result: {kind: 'identifier', title: x.title, value: x.value, document: d}})),
          ...(o?.links ?? []).map(x => ({kind: 'link', id: `link:${x.url}`, result: {kind: 'link', title: x.title, value: x.url, document: d}}))]} : null;
    }
    case 'needs': return {key: 'section:needs', title: 'Needs you'};
    case 'need': return {key: 'section:needs', title: 'Needs you', carry: true};
    case 'house': return {key: 'section:actions', title: 'House'};
    case 'action': return {key: 'section:actions', title: 'House', carry: true};
    case 'recent': return {key: 'section:recent', title: 'Recent', carry: true};
  }
  return null;
}

/** A row's group unless it is one already open (a section's rows inside that section). */
const groupIn = (state, row) => { const g = groupOf(row); return g && !(state.scopes ?? []).some(sc => sc.key === g.key) ? g : null; };

/** A group member's searchable text: title, type, period or date as shown, source, reason, the period it is an alternate of; a
 *  series (a topic's account) its title and span. */
const memberText = r => {
  if (['person', 'trip', 'event', 'day', 'none'].includes(r.kind)) return `${r.result.title} ${r.result.subtitle ?? ''}`;
  if (r.kind === 'series') { const l = seriesLines(r.series); return `${l.title} ${l.subtitle}`; }
  if (r.kind === 'project') { const l = projectLines(r.project); return `${l.title} ${l.subtitle}`; }
  const d = r.result.document; return [r.kind === 'document' ? d.title : `${r.result.title} ${r.result.value}`, docSubtitle(d), sourceName(d.source), r.reason, r.alternateOf].filter(Boolean).join(' ');
};

/** An open group's rows, filtered by the query: a section's (its rule, no limit), else its members (inline, or env.groups[key].items:
 *  [{document, reason?}], none while loading), picked ones first. */
function scopeRows(scope, query, env) {
  const ws = words(query);
  if (scope.key === 'section:actions') return (env.actions ?? []).filter(a => actionMatch(ws, a)).map(actionRow);
  if (scope.key === 'section:needs') return (env.needs ?? []).filter(n => textMatch(ws, needText(n))).map(needRow);
  if (scope.key === 'section:recent') return (env.recent ?? []).filter(i => textMatch(ws, recentText(i))).map(recentRow);
  const all = scope.rows ?? (env.groups?.[scope.key]?.items ?? []).map(i => memberRow(i.document, i.reason ? {reason: i.reason} : {}));
  return byPicks(all.filter(r => textMatch(ws, memberText(r))), env.picks);
}

/** The rows for a state: an open group's; else the codes, the Needs you row, Recent and the House row when the query is empty (no
 *  action is one key from running); else Ask, commands, actions, found, Recent's matches (SPEC.md, *Rows*). */
export function rows(state, env) {
  const scope = state.scopes?.at(-1);
  if (scope) return scopeRows(scope, state.query, env);
  if (state.answer) return (state.answer.citations ?? []).map(c => ({kind: 'citation', id: `citation:${c.id}`, citation: c}));
  const q = state.query.trim(), ws = words(q);
  if (!q) return [...(env.codes ?? []).slice(0, MAX.codes).map(codeRow), ...(env.needs?.length ? [needsRow(env.needs.length)] : []), ...(env.recent ?? []).map(recentRow), ...(env.actions?.length ? [houseRow(env.actions.length)] : [])];
  if (/^people(?:\s|:|$)/i.test(q)) return (env.found?.[q] ?? []).map(foundRow);
  // a query of punctuation alone (`?`) has no words: nothing to match but Ask and found
  const cmds = !ws.length || env.commands === false ? [] : byPicks(commands(env.targets ?? []).filter(c => ws.every(w => words(c.title).some(t => near(t, w)))), env.picks).slice(0, MAX.commands);
  const lead = cmds.some(c => near(words(c.title)[0], ws[0]));
  const actions = !ws.length ? [] : (env.actions ?? []).filter(a => actionMatch(ws, a)).slice(0, MAX.actions).map(actionRow);
  const order = env.foundOrder?.[q];
  const results = collapse(env.found?.[q] ?? []);
  let found = byPicks((order ? results : results.slice(0, MAX.found)).map(foundRow), env.picks);
  if (order) found.sort((a, b) => (order.indexOf(a.id) < 0 ? order.length : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? order.length : order.indexOf(b.id)));
  found = found.slice(0, MAX.found);
  const recent = !ws.length ? [] : (env.recent ?? []).filter(i => textMatch(ws, recentText(i))).slice(0, MAX.recent).map(recentRow);
  return [
    ...(isQuestion(q) ? [{kind: 'ask', id: 'ask', query: q}] : []),
    ...(lead ? cmds : []), ...actions, ...found, ...recent, ...(lead ? [] : cmds),
  ];
}

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** The periods a query names: a year (`2019`), a month (`2025-09`, `sep 2025`, `september 2025`, `2025 sept`). */
export function periodsIn(query) {
  const ws = words(query), month = w => w && w.length >= 3 ? FULL_MONTHS.findIndex(f => f.startsWith(w)) : -1;
  return ws.flatMap((w, i) => {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(w)) return [w];
    if (!/^(19|20)\d{2}$/.test(w)) return [];
    const m = [month(ws[i - 1]), month(ws[i + 1])].find(k => k >= 0);
    return [m == null ? w : `${w}-${String(m + 1).padStart(2, '0')}`];
  });
}

/** The member of a series row a query names a period of (`tax 2019` → the 2019 member; a year → its newest month), else null. */
export function landing(row, query) {
  if (row?.kind !== 'series') return null;
  for (const p of periodsIn(query)) {
    const i = row.series.members.findIndex(m => m.period === p || (p.length === 4 && m.period?.startsWith(`${p}-`)));
    if (i >= 0) return i;
  }
  return null;
}

/** The focused chip of a series row: the one ←/→ moved to, else none after Left from the first or Esc (-1), else the member the
 *  query names (`landing`). */
const chipOf = (state, row) => row?.kind !== 'series' || state.chip === -1 ? null : state.chip ?? landing(row, state.query);

/** The selected row's index: the chosen one while it is shown; else, with a query, an answer or an open group, the first (a query
 *  naming a period: the series row holding it); else none (-1). */
export function selection(state, env, list = rows(state, env)) {
  const i = state.selected == null ? -1 : list.findIndex(r => r.id === state.selected);
  if (i >= 0) return i;
  if (!list.length) return -1;
  if (state.scopes?.length) return 0;
  if (!state.query.trim() && !state.answer) return -1;
  const landed = state.answer ? -1 : list.findIndex(r => landing(r, state.query) != null);
  if (landed >= 0) return landed;
  return list.findIndex(r => !(NOTES.has(r.kind) && !r.result.document)); // a line with nothing to view is never selected by itself
}

export const initial = () => ({query: '', selected: null, confirm: null, answer: null, chip: null, scopes: []});

/** The box's text replaced as a whole (typing, Backspace or a paste in the app's own box): as typing it, the selection, an answer,
 *  a focused chip and a pending confirmation go. An open group stays (its box filters it). */
export const edit = (state, text) => ({...initial(), ...state, query: text, selected: null, answer: null, chip: null, confirm: null});

/** A row chosen by id (a click, the host's `link act`): selected as Down would; a pending confirmation is cancelled, a focused chip
 *  kept only on the same row. */
export const select = (state, id) => ({...initial(), ...state, selected: id, confirm: null, chip: state.selected === id ? state.chip ?? null : null});

/** The series member Enter, Mod+Enter and Space act on: the focused chip's, else the newest. */
const member = (row, state) => row.series.members[chipOf(state, row) ?? 0];

/** The row a person chose (Down, Up, a click) and still shown, or an open group's first row while its box is empty; else null:
 *  Space and ←/→ act only on it, never on the first row a query selects by itself (there Space types and ←/→ move the caret). */
function chosen(state, env, list = rows(state, env)) {
  if (state.selected != null) return list.find(r => r.id === state.selected) ?? null;
  return state.scopes?.length && !state.query.trim() ? list[0] ?? null : null;
}

/** Whether a row opens in the viewer (SPEC.md, *Viewer*): a found document, a series, a project (its best-tied document), a
 *  citation, a thing (its view: bridge's `pages` of its document), a Recent image or file. */
export const viewable = row => ['document', 'series', 'project', 'citation', 'thing', 'person', 'trip', 'event'].includes(row?.kind) || noted(row) || (row?.kind === 'recent' && ['image', 'file'].includes(row.item.kind));

/** A row → opens: a project, an order, a topic, an area, a thing, a person, a trip, the more trips, the House or the Needs you row (a
 *  series' → moves its chips). */
const drills = row => row?.kind === 'house' || row?.kind === 'needs' || /^(project|order|topic|area|thing|person|trip|trips|event|day|tally):/.test(groupOf(row)?.key ?? '');

/** A row whose Enter opens its group, its chart heading it (SPEC.md, *Topics*): a project, the House or the Needs you row, a topic,
 *  an area, the more trips, and a utility's or a vendor's series (`series.chart`) with no chip focused (a focused chip's Enter views
 *  that bill). */
const opens = (row, state) => ['project', 'house', 'needs', 'topic', 'area', 'trips', 'day'].includes(row?.kind) || (row?.kind === 'series' && !!row.series.chart && chipOf(state, row) == null);

/** Whether the model takes Space, Left or Right from the search box (true) or the box keeps it (false: a space typed, the caret
 *  moved). Other keys: always the model's. A pending confirmation does not change it: Space cancels it and views. */
export function takes(state, env, k) {
  const row = chosen(state, env);
  if (k === 'Space') return viewable(row);
  if (k === 'Left') return row?.kind === 'series';
  if (k === 'Right') return row?.kind === 'series' || (drills(row) && !!groupIn(state, row));
  return true;
}

/** Space's and Enter's effect: the viewer, on a document (`id`, with the query for its match) or a Recent item (`recent`). */
function view_(row, state) {
  const query = (state.scopes?.length ? state.scopes[0].back.query : state.query).trim();
  switch (row.kind) {
    case 'document': case 'project': case 'thing': case 'person': case 'trip': case 'event': case 'answer': case 'none': return row.result.document ? {type: 'view', id: row.result.document.id, query} : null;
    case 'series': return {type: 'view', id: member(row, state).id, query};
    case 'citation': return {type: 'view', id: row.citation.id, query};
    case 'recent': return {type: 'view', recent: row.item.id};
  }
  return null;
}

/** Sources whose documents have no original to download (bridge's `/v1/doc/<id>/file`): mail, texts, house records, orders, ref rows. */
const NO_FILE = new Set(['gmail', 'messages', 'house', 'house-model', 'amazon', 'ref', 'bridge']);
/** Whether a document's (a citation's, a series member's) original downloads: bridge's `file` where it says, else by its source (none
 *  named: no). The viewer's Open file shows only then (SPEC.md, *Viewer*): never a download the OS cannot open. */
export const hasFile = d => typeof d?.file === 'boolean' ? d.file : !!d?.source && !NO_FILE.has(String(d.source).toLowerCase());

/** A downloaded original's name always with an extension the OS can open it by (SPEC.md, *Actions (model effects)*): one without
 *  (a mail named by its message id) takes its Content-Type's; none known: the name as given, which the app reveals, never opens. */
const EXTENSIONS = {'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/heic': 'heic',
  'image/webp': 'webp', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'message/rfc822': 'eml', 'application/zip': 'zip',
  'application/json': 'json', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'};
/** An extension: 1–5 letters or digits, one a letter, after the last dot (`v1.2` has none). */
const hasExtension = name => /\.(?=[a-z0-9]{1,5}$)[0-9]*[a-z]/i.test(name ?? '');
export function fileName(name, contentType) {
  const ext = EXTENSIONS[String(contentType ?? '').split(';')[0].trim().toLowerCase()];
  return hasExtension(name) || !ext ? name : `${name}.${ext}`;
}

/** Enter's effect on a row (a project's and the House row's open their group: `step`): a document-like row views it (a download is
 *  the viewer's Open file). */
function primary(row, state) {
  switch (row.kind) {
    case 'series': case 'document': case 'citation': case 'thing': case 'person': case 'trip': case 'event': case 'answer': case 'none': return view_(row, state);
    case 'ask': return {type: 'ask', query: row.query};
    case 'command': return row.effect;
    case 'action': return row.action.confirm ? {type: 'confirm', what: 'act', id: row.action.id} : {type: 'act', id: row.action.id};
    case 'identifier': return {type: 'copy', value: row.result.value, sensitive: true};
    case 'link': return {type: 'copy', value: row.result.value, sensitive: false};
    case 'recent': return viewable(row) ? view_(row, state) : {type: 'copyRecent', id: row.item.id};
    case 'need': return needEffect(row.need);
    // the host puts the code on the clipboard from its own memory (codes.copy), kept out of clipboard history
    case 'code': return {type: 'copyCode', id: row.code.id};
  }
  return null;
}

/** A need's action (SPEC.md, *Needs you*): a page opened (`url`), the backend asked to do it (`op`: effect `need`), a command copied. */
function needEffect(n) {
  const a = n.action;
  if (a?.kind === 'url' && a.url) return {type: 'open', url: a.url};
  if (a?.kind === 'op') return {type: 'need', id: n.id, ...(n.backend && n.backend !== 'bridge' ? {backend: n.backend} : {})};
  if (a?.kind === 'command' && a.command) return {type: 'copy', value: a.command, sensitive: false};
  return null;
}

/** Mod+Enter's (a long press's) effect on a row; null where it has none. */
function secondary(row, state) {
  switch (row.kind) {
    case 'event': return row.event.link ? {type: 'open', url: row.event.link} : null;
    case 'series': return {type: 'document', id: member(row, state).id, file: false};
    case 'project': return {type: 'map', by: 'project', value: row.project.id};
    case 'ask': case 'command': case 'action': return primary(row);
    case 'identifier': return row.result.document ? {type: 'document', id: row.result.document.id, file: false} : null;
    case 'link': return {type: 'open', url: row.result.value};
    case 'document': case 'thing': case 'person': case 'trip': return {type: 'document', id: row.result.document.id, file: false};
    case 'answer': case 'none': return row.result.document ? {type: 'document', id: row.result.document.id, file: false} : null;
    case 'citation': return {type: 'document', id: row.citation.id, file: false};
    case 'recent':
      if (row.item.link) return {type: 'open', url: row.item.link};
      return row.item.kind === 'file' ? {type: 'reveal', id: row.item.id} : row.item.kind === 'image' ? {type: 'copyRecent', id: row.item.id} : null;
  }
  return null;
}

/** A document's source as people name it (bridge's `document.source`, a citation's `source`): the source chip and the hint's
 *  Mod+Enter (SPEC.md, *Row kinds*). Unknown names stay as they are; none is null. */
export const SOURCES = {seafile: 'Seafile', immich: 'Immich', gmail: 'Gmail', messages: 'Messages', signal: 'Signal', kb: 'kb', house: 'House', 'house-model': 'House', amazon: 'Amazon',
  delivery: 'Delivery', ref: 'ref', github: 'GitHub', bridge: 'Deck'};
export const sourceName = s => s ? SOURCES[String(s).toLowerCase()] ?? String(s) : null;
const openIn = s => sourceName(s) ? `Open in ${sourceName(s)}` : 'Open source';

/** A series member's source (bridge's `members[].source`), else the document carrying the series': the row's chip names the
 *  newest's, the hint the member Mod+Enter opens (the focused chip's). */
const seriesSource = (row, i = 0) => row.series.members[i]?.source ?? row.result.document.source;

/** Labels for the hint line: Enter's and Mod+Enter's per row. */
function labels(row, state) {
  switch (row.kind) {
    case 'series': { const c = chipOf(state, row); return [c == null ? (row.series.chart ? 'Show chart' : 'View newest') : `View ${seriesLines(row.series).chips[c].label}`, openIn(seriesSource(row, c ?? 0))]; }
    case 'project': return ['Show all', 'Open map'];
    case 'topic': return ['Show chart', null];
    case 'area': case 'trips': case 'day': return ['Show all', null];
    case 'house': case 'needs': return ['Show all', null];
    case 'need': { const a = row.need.action; return [needEffect(row.need) ? a.label || {url: 'Open', op: 'Run', command: 'Copy'}[a.kind] : null, null]; }
    case 'code': return ['Copy', null];
    case 'ask': return ['Ask', null];
    case 'command': case 'action': return ['Run', null];
    case 'identifier': return ['Copy', row.result.document ? openIn(row.result.document.source) : null];
    case 'link': return ['Copy', 'Open'];
    case 'event': return ['View', row.event.link ? 'Open Calendar' : null];
    case 'document': case 'thing': case 'person': case 'trip': return ['View', openIn(row.result.document.source)];
    case 'answer': case 'none': return row.result.document ? ['View', openIn(row.result.document.source)] : [null, null];
    case 'citation': return ['View', openIn(row.citation.source)];
    case 'recent':
      if (row.item.kind === 'file') return ['View', 'Show'];
      if (row.item.kind === 'image') return ['View', 'Copy'];
      return ['Copy', row.item.link ? 'Open' : null];
  }
  return [null, null];
}

/** Open a row's group (or one by key from elsewhere: the viewer's Related rail and chips): pushed over what was shown, which comes
 *  back as it was (query, selection, chip, answer). A section keeps the query; another group starts empty, on the focused chip's
 *  member, else its first row. Effect `group` when the app fetches the rows. */
function openGroup(s, row, g) {
  const c = chipOf(s, row);
  s.scopes = [...(s.scopes ?? []), {key: g.key, title: g.title, rows: g.rows ?? null, back: {query: s.query, selected: s.selected, chip: s.chip, answer: s.answer}}];
  s.selected = c != null ? `doc:${row.series.members[c].id}` : g.carry ? row.id : null;
  s.query = g.carry ? s.query : ''; s.answer = null; s.chip = null;
  return [s, g.load ? {type: 'group', key: g.key} : null];
}

/** Close the open group: back to what it was opened from. */
function pop(s) {
  const top = s.scopes.at(-1);
  s.scopes = s.scopes.slice(0, -1);
  Object.assign(s, top.back);
  return [s, null];
}

/** One key: [new state, effect or null]. Keys: `Type:<text>`, Space, Backspace, Up, Down, Left, Right, Tab, Shift+Tab, Enter,
 *  Shift+Enter, Mod+Enter, Esc, Mod+1…9, Mod+S, Mod+R, Mod+P, Mod+Backspace, Mod+Delete, Mod+Shift+Backspace, Remove (a Recent
 *  row's menu item); `Answer` delivers env.answers[query] (the ask's reply); `Group:<key>` opens that group (env.groups[key]:
 *  `{title, items}`; the viewer's chips and Related rail). A chip's focus lasts while its row stays selected. */
export function key(state, env, k) {
  const [s, e] = step({chip: null, scopes: [], ...state}, env, k);
  const list = rows(s, env), at = selection(s, env, list);
  if (s.chip != null && (at < 0 || list[at].kind !== 'series' || (s.selected != null && list[at].id !== s.selected))) s.chip = null;
  return [s, e];
}

/** The keys that clear the box when it holds text; on an empty box they keep their own (remove a Recent item, clear Recent). */
export const CLEARS = new Set(['Mod+Backspace', 'Mod+Delete', 'Mod+Shift+Backspace']);

function step(state, env, k) {
  let s = {...state};
  const list = rows(s, env), at = selection(s, env, list), row = at >= 0 ? list[at] : null;
  if (s.confirm) {
    const c = s.confirm;
    s.confirm = null;
    if (k === 'Enter') return [s, {share: {type: 'share'}, remove: {type: 'remove', id: c.id}, act: {type: 'act', id: c.id}, clear: {type: 'clear'}}[c.what]];
    if (k === 'Esc') return [s, null];
  }
  if (k === 'Space' && takes(s, env, k)) return [s, view_(chosen(s, env, list), s)];
  if (k === 'Left' || k === 'Right') {
    if (!takes(s, env, k)) return [s, null];
    const r = chosen(s, env, list);
    if (r.kind !== 'series') return openGroup(s, r, groupIn(s, r));
    const n = r.series.members.length, c = chipOf(s, r);
    s.chip = k === 'Right' ? Math.min((c ?? -1) + 1, n - 1) : c ? c - 1 : -1;
    return [s, null];
  }
  if (k === 'Tab') { const g = groupIn(s, row); return g ? openGroup(s, row, g) : [s, null]; }
  if (k === 'Shift+Tab') return s.scopes.length ? pop(s) : [s, null];
  if (k.startsWith('Group:')) { const key = k.slice(6); return openGroup(s, null, {key, title: env.groups?.[key]?.title ?? key.slice(key.indexOf(':') + 1), load: true}); }
  if (k === 'Backspace' && s.scopes.length && !s.query) return pop(s);
  // with text in the box, Mod+Backspace, Mod+Delete and Mod+Shift+Backspace clear it, as one edit (SPEC.md, *Keys*)
  if (CLEARS.has(k) && s.query) return [edit(s, ''), null];
  const typed = k.startsWith('Type:') || k === 'Backspace' || k === 'Space';
  if (typed) {
    s.query = k === 'Backspace' ? s.query.slice(0, -1) : s.query + (k === 'Space' ? ' ' : k.slice(5));
    s.selected = null; s.answer = null; s.chip = null;
    return [s, null];
  }
  // the transfer commands' keys: none where the app has no transfers (env.commands false: the site)
  if (env.commands === false && /^Mod\+([1-9]|S|R|P)$/.test(k)) return [s, null];
  const target = /^Mod\+([1-9])$/.exec(k);
  if (target) {
    const t = (env.targets ?? [])[Number(target[1]) - 1];
    return [s, t ? {type: 'send', to: [t]} : null];
  }
  switch (k) {
    case 'Down': if (list.length) s.selected = list[Math.min(at + 1, list.length - 1)].id; s.chip = null; return [s, null];
    case 'Up':
      if (at > 0) s.selected = list[at - 1].id;
      else if (at === 0 && !s.query.trim() && !s.answer && !s.scopes.length) s.selected = null;
      s.chip = null;
      return [s, null];
    case 'Enter': {
      if (!row) return [s, null];
      if (opens(row, s)) { const g = groupIn(s, row); return g ? openGroup(s, row, g) : [s, null]; }
      const e = primary(row, s);
      if (e?.type === 'confirm') { s.confirm = {what: e.what, id: e.id}; return [s, null]; }
      return [s, e];
    }
    case 'Mod+Enter': {
      if (!row) return [s, null];
      const e = secondary(row, s);
      if (e?.type === 'confirm') { s.confirm = {what: e.what, id: e.id}; return [s, null]; }
      return [s, e];
    }
    case 'Shift+Enter': return [s, s.query.trim() ? {type: 'ask', query: s.query.trim()} : null];
    case 'Answer': s.answer = env.answers?.[s.query.trim()] ?? null; s.selected = null; return [s, null];
    case 'Esc':
      if (chipOf(s, row) != null) s.chip = -1;
      else if (s.answer) s.answer = null;
      else if (s.query) { s.query = ''; s.selected = null; }
      else if (s.scopes.length) return pop(s);
      else if (s.selected != null) s.selected = null;
      else return [s, {type: 'close'}];
      return [s, null];
    case 'Mod+S': return [s, {type: 'send', to: null}];
    case 'Mod+R': return [s, {type: 'receive'}];
    case 'Mod+P': s.confirm = {what: 'share'}; return [s, null];
    case 'Mod+Backspace': case 'Mod+Delete': case 'Remove': if (row?.kind === 'recent') s.confirm = {what: 'remove', id: row.item.id}; return [s, null];
    case 'Mod+Shift+Backspace': s.confirm = {what: 'clear'}; return [s, null];
  }
  return [s, null];
}

/** Whether Tab's group shows more than the rows do now: always for a series, project, order, topic, area, thing, person, trip or the House row; a section when rows
 *  of it are hidden (5 matching actions of more; Recent's 5 matches of more). */
function more(state, env, list, row) {
  const g = groupIn(state, row);
  if (!g) return false;
  if (!g.carry) return true;
  return scopeRows(g, state.query, env).length > list.filter(r => r.kind === row.kind).length;
}

/** The hint line: [key, label] pairs, at most four; Mod is ⌘ on the Mac, Ctrl on Windows. Esc is named only where nothing is
 *  selected (Close, Clear, Back) and on a confirmation (Cancel); the breadcrumb says an open group's Esc. Nothing selected: Down
 *  on an empty query, Ask when a query found nothing (the send keys are the commands bar's, never repeated here). */
export function hint(state, env) {
  if (state.confirm) return [['Enter', {share: 'Create link', remove: 'Remove', clear: 'Clear all', act: 'Run'}[state.confirm.what]], ['Esc', 'Cancel']];
  const list = rows(state, env), at = selection(state, env, list);
  if (at < 0) {
    if (state.scopes?.length) return [['Esc', state.query ? 'Clear' : 'Back']];
    if (state.answer) return [['Esc', 'Clear']];
    if (state.query.trim()) return [['Shift+Enter', 'Ask'], ['Esc', 'Clear']];
    return list.length ? [['Down', 'Select'], ['Esc', 'Close']] : [['Esc', 'Close']];
  }
  const row = list[at], [enter, mod] = labels(row, state);
  // Space is Enter's alias on a document-like row (both view); named only where it does something else (a project's best document)
  return [...(row.kind === 'project' && takes(state, env, 'Space') ? [['Space', 'View']] : []), ...(enter ? [['Enter', enter]] : []), ...(mod ? [['Mod+Enter', mod]] : []),
    ...(!opens(row, state) && more(state, env, list, row) ? [['Tab', 'Show all']] : [])];
}

/** The viewer's Related rail from bridge's `/v1/related/<id>` (SPEC.md, *Related*): `chips`, where else to go (its day, projects,
 *  rarest subjects; each a group key: `day:<date>`, `project:<id>`, `subject:<name>`), then `groups` in bridge's order (an empty one
 *  left out; an unknown kind by its label): `{key: related:<id>:<kind>, kind, label, count, items: [{id: doc:<id>, title, reason,
 *  document}], more}`, more being how many the group holds beyond its items (its own list, Tab). */
export function relatedRail(related) {
  const id = related.document?.id;
  const chips = [
    ...(related.day ? [{kind: 'day', key: `day:${related.day}`, label: dateLabel(related.day)}] : []),
    ...(related.projects ?? []).map(p => ({kind: 'project', key: `project:${p.id}`, label: p.name})),
    ...(related.subjects ?? []).map(n => ({kind: 'subject', key: `subject:${n}`, label: n})),
  ];
  const groups = (related.groups ?? []).filter(g => g.items?.length).map(g => {
    const count = Math.max(g.count ?? 0, g.items.length);
    return {key: `related:${id}:${g.kind}`, kind: g.kind, label: g.label || g.kind, count,
      items: g.items.map(i => ({id: `doc:${i.document.id}`, title: i.document.title, reason: i.reason ?? '', document: i.document})),
      more: count - g.items.length};
  });
  return {chips, groups};
}

/** A state as the cases compare it; `series` the selected series row's lines, chips' labels and focused chip (else null); `scope`
 *  the open groups' titles, outermost first (the breadcrumb; else null). */
export function view(state, env) {
  const list = rows(state, env), at = selection(state, env, list), row = at >= 0 ? list[at] : null;
  const lines = row?.kind === 'series' ? seriesLines(row.series) : null;
  return {query: state.query, rows: list.map(r => r.id), selected: row ? row.id : null, confirm: state.confirm?.what ?? null,
    answer: !!state.answer, hint: hint(state, env), scope: state.scopes?.length ? state.scopes.map(x => x.title) : null,
    series: lines && {title: lines.title, subtitle: lines.subtitle, chips: lines.chips.map(c => c.label), chip: chipOf(state, row)}};
}
