// The palette's model, the executable form of SPEC.md: which rows a query shows, which one is selected, what each key does and the
// hint line. Pure: no I/O. Windows (desktop/windows), the Mac (desktop/mac) and Android implement the same and pass cases.json; this
// one passes it in npm test (test/palette.test.mjs).

import {pageRange} from '../ui/src/collection-window.js';
import {collectionTarget, physicalThingId} from '../ui/src/collection-target.js';

export const MAX = {found: 8, recent: 5, commands: 4, actions: 5, codes: 5, answered: 50};

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
 *  away from the word's start of about its length, past its first letter (`boom` never reaches `room`). */
export const near = (t, w) => t.startsWith(w) || (w.length >= 4 && t[0] === w[0] && !/^\d+$/.test(w) && [w.length - 1, w.length, w.length + 1].some(n => n <= t.length && distance(t.slice(0, n), w) <= 1));

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

/** Flightplan's items among the found rows (SPEC.md, *Flightplan in Find*: a word search's matches, a find rule's answer), each
 *  `{kind, title, subtitle, item, url?, snooze?}`: Enter marks it done, Tab or → lists its snooze choices, Mod+Enter opens its issue. */
const PLAN = new Set(['todo', 'task', 'epic']);

/** A flightplan row still open (neither done nor dropped): Enter marks it done. */
const planOpen = row => !['done', 'dropped'].includes(row.item.status);

/** `todo <text>`: the text flightplan's quick add takes (SPEC.md, *Capture*), else null. */
export const captureText = q => { const m = /^todo\s+(\S.*)$/is.exec(String(q).trim()); return m ? m[1].trim() : null; };

/** `note <text>` keeps the note's line breaks and links. */
export const noteText = q => { const m = /^note\s+(\S.*)$/is.exec(String(q).trim()); return m ? m[1].trim() : null; };

/** The capture's rows (env.capture: flightplan's reading of the text, `{text, preview: {for, title, due, repeat, remind, ambiguous},
 *  choices, busy, error}`): the line as flightplan reads it (Enter adds it); a reading that is ambiguous makes it a line to read and
 *  lists its choices instead (Enter on one adds the line with it). */
function captureRows(text, cap) {
  const preview = cap.preview?.for === text ? cap.preview : null;
  const ask = (String(cap.text ?? '').trim() === text ? cap.choices : null) ?? preview?.ambiguous?.[0] ?? null;
  return [{kind: 'capture', id: 'capture', text, preview, ask, busy: !!cap.busy, error: cap.error ?? null},
    ...(ask?.choices ?? []).map((choice, i) => ({kind: 'choice', id: `choice:${i}`, text, choice, ask}))];
}

/** A found result (bridge's find) as a row: identifiers and links by value, documents by id; a document carrying `series` is the
 *  series' row; a utility topic (`topic`: its accounts' usage as one chart) its own, as an area of the home (`area`: its clusters and
 *  services), a thing (`thing`: a device or plant of the house), a person (`person`), a trip (`trip`), the more trips (`trips`: the
 *  trips past bridge's first four) and the more events (`events`: the events past bridge's first four). */
function foundRow(r) {
  const row = rowOf(r);
  // the photos bridge found of it (`withPhotos`): its strip, its full view's
  return r.photos && r.kind !== 'photos' ? {...row, photos: r.photos} : row;
}
function rowOf(r) {
  // an item or a change an exact id named (SPEC.md, *Identifiers*)
  if (r.kind === 'item' && r.item) return {kind: 'item', id: `item:${r.item.id}`, result: r, item: r.item};
  if (r.kind === 'change' && r.change) return {kind: 'change', id: `change:${r.change.repo}#${r.change.pr}`, result: r};
  if (PLAN.has(r.kind) && r.item) return {kind: r.kind, id: `${r.kind}:${r.item.id}`, result: r, item: r.item};
  if (r.kind === 'project' && r.project) return {kind: 'project', id: `project:${r.project.id}`, result: r, project: r.project};
  if (r.kind === 'thing') return {kind: 'thing', id: `thing:${r.thing.id}`, result: r, thing: r.thing};
  if (['person', 'trip', 'event'].includes(r.kind) && r[r.kind]) return {kind: r.kind, id: `${r.kind}:${r[r.kind].id}`, result: r, [r.kind]: r[r.kind]};
  if (r.kind === 'day') return {kind: 'day', id: `day:${r.day.date}`, result: r, day: r.day};
  if (r.kind === 'topic') return {kind: 'topic', id: `topic:${r.topic.key}`, result: r, topic: r.topic};
  if (r.kind === 'area') return {kind: 'area', id: `area:${r.area.key}`, result: r, area: r.area};
  if (r.kind === 'trips' && r.trips) return {kind: 'trips', id: `trips:${r.trips.key}`, result: r, trips: r.trips};
  if (r.kind === 'events' && r.events) return {kind: 'events', id: `events:${r.events.key}`, result: r, events: r.events};
  if (r.kind === 'document' && r.series) return {kind: 'series', id: `series:${r.series.key}`, result: r, series: r.series};
  if (r.kind === 'cluster') return {kind: 'cluster', id: `cluster:${r.cluster.id}`, result: r, cluster: r.cluster};
  if (r.kind === 'photos') return {kind: 'photos', id: `photos:${r.title}`, result: r, photos: photoSet(r)};
  // bridge's answer and none rows (a stored fact answering the query; a line saying what is not there) by their title
  const id = r.kind === 'document' ? `doc:${r.document.id}` : NOTES.has(r.kind) ? `${r.kind}:${r.title}` : `${r.kind}:${r.value ?? r.document?.id}`;
  return {kind: r.kind, id, result: r};
}

// The found kinds a row shows (SPEC.md, *Row kinds*); a result of any other kind (one bridge added since) shows only when it has a
// document to view, as a document does, and is left out otherwise: never in the way of the rows around it.
const FOUND = new Set([...PLAN, 'item', 'change', 'project', 'thing', 'person', 'trip', 'trips', 'event', 'events', 'day', 'topic', 'area', 'document',
  'cluster', 'identifier', 'link', 'answer', 'none', 'photos']);
const shows = r => FOUND.has(r?.kind) || (!!r?.document && typeof r.document === 'object');

/** A `photos` result's set as the strip and the viewer take it: `{title, ids, thumbnails: [{id, url}], total, at, place}` (bridge
 *  CONTRACT.md *Find photos*), thumbnails only of its ids; null with none. */
export function photoSet(r) {
  const p = r?.photos, ids = new Set(Array.isArray(p?.ids) ? p.ids : []);
  const thumbnails = (Array.isArray(p?.thumbnails) ? p.thumbnails : []).filter(t => ids.has(t?.id) && typeof t.url === 'string');
  if (!thumbnails.length) return null;
  return {title: String(r.title ?? 'Photos'), ids: thumbnails.map(t => t.id), thumbnails, total: Math.max(Number(p.total) || 0, thumbnails.length),
    at: p.at?.from ? {from: p.at.from, to: p.at.to ?? p.at.from} : null, place: p.place ?? null};
}
// What bridge finds photos of (CONTRACT.md *Find photos*): a person, a trip, a day, a house record or a property (a `thing` row).
const PHOTOGRAPHED = new Set(['person', 'trip', 'day', 'thing']);
const PHOTOS_OF = /^Photos · /;
/** The title of the row a photos result is of, else null. */
const photosOf = r => r?.kind === 'photos' && PHOTOS_OF.test(r.title ?? '') ? r.title.replace(PHOTOS_OF, '') : null;
/** Bridge's photos (`photos` results, each titled `Photos · <the title of the row it is of>`) on the rows they are of, the more trips'
 *  too (SPEC.md, *Photos*): that row carries the set as `photos`, and the photos result goes. A title two such rows share (two people
 *  of one name) or two photos results share puts the photos on neither and drops them: never someone else's photos on a row. A
 *  photos result of no row (a photo search's: `photos of the beach`) stays its own row. */
export function withPhotos(results) {
  const sets = new Map(), owners = new Map();
  const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const each = fn => { for (const r of results) { fn(r); for (const t of r.kind === 'trips' ? r.trips?.results ?? [] : []) fn(t); } };
  each(r => { if (PHOTOGRAPHED.has(r?.kind) && r.title) count(owners, r.title); });
  for (const r of results) if (photosOf(r) != null) count(sets, photosOf(r));
  const found = new Map();
  for (const r of results) { const of = photosOf(r); if (of != null && sets.get(of) === 1 && owners.get(of) === 1) found.set(of, photoSet(r)); }
  const put = r => PHOTOGRAPHED.has(r?.kind) && found.get(r.title) ? {...r, photos: found.get(r.title)} : r;
  return results.flatMap(r => {
    if (r?.kind === 'photos') { const of = photosOf(r); return of != null && (owners.has(of) || sets.get(of) > 1) || !photoSet(r) ? [] : [r]; }
    return [r.kind === 'trips' && r.trips?.results ? {...r, trips: {...r.trips, results: r.trips.results.map(put)}} : put(r)];
  });
}

/** Bridge's results with each series collapsed: the document carrying `series` stays (as the series' row), its other members'
 *  documents and their alternates go, wherever they are (SPEC.md, *Series*); photos on the rows they are of (`withPhotos`). */
export function collapse(results) {
  const members = new Set(results.flatMap(r => r.kind === 'document' && r.series
    ? r.series.members.flatMap(m => [m.id, ...(m.alternates ?? []).map(a => a.id)]) : []));
  return withPhotos(results.filter(r => shows(r) && (r.kind !== 'document' || r.series || !members.has(r.document?.id))));
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

/** A member's chip: its period (`2025`, `Aug 2025`); a day (`2025-08-28`) as its month, or `Aug 28` when another member shares that
 *  month (the deck/ui format.js style). */
const memberLabel = (p, periods) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(p)) return periodLabel(p);
  const month = p.slice(0, 7);
  return periods.filter(q => String(q).slice(0, 7) === month).length > 1 ? `${MONTHS[Number(p.slice(5, 7)) - 1]} ${Number(p.slice(8, 10))}` : periodLabel(month);
};
/** A series row's lines and chips: title `series.title`; subtitle the span of its periods and its count (`2012–2025 · 14`,
 *  `Jul–Sep 2025 · 3`); a chip per member, newest first (`{id, label}`; a member without a period: its title). */
export function seriesLines(series) {
  const periods = series.members.map(m => m.period).filter(Boolean).sort();
  const range = span(periods[0], periods.at(-1));
  const count = series.count ?? series.members.length;
  return {title: series.title, subtitle: range ? `${range} · ${count}` : `${count}`,
    chips: series.members.map(m => ({id: m.id, label: m.period ? memberLabel(m.period, periods) : m.title}))};
}

const KINDS = {home: 'Home', purchase: 'Purchase', vehicle: 'Vehicle', travel: 'Travel', move: 'Move', legal: 'Legal', tax: 'Tax',
  finance: 'Finance', health: 'Health', family: 'Family', work: 'Work', event: 'Event', other: 'Cluster'};
/** A cluster row's lines (bridge's find kind `cluster`): its name over kind · span · count (`Home · Apr–Jul 2025 · 23`). */
export function clusterLines(cluster) {
  return {title: cluster.name, subtitle: [KINDS[cluster.kind] ?? 'Cluster', span(cluster.from, cluster.to), cluster.count].filter(v => v != null && v !== '').join(' · ')};
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
// a thread of texts, whichever app it came from (Messages, Signal, WhatsApp, iMessage, SMS: bridge's `type: messages`)
const CHATS = new Set(['messages', 'signal', 'whatsapp', 'imessage', 'sms']);
export function docGlyph(document) {
  const source = String(document?.source ?? '').toLowerCase(), type = String(document?.type ?? '').toLowerCase();
  if (CHATS.has(source) || type === 'messages' || type === 'conversation') return 'chat';
  if (source === 'immich') return /video/.test(type) ? 'video' : 'photo';
  const hit = GLYPHS.find(([re]) => re.test(type));
  if (hit) return hit[1];
  return {kb: 'note', house: 'house', 'house-model': 'house', ref: 'key'}[source] ?? 'document';
}

/** A house action as a row; its id `action:<action id>`. env.actions retains Habitat entity order (SPEC.md, *Actions*). */
function actionRow(a) {
  return {kind: 'action', id: `action:${a.id}`, action: a};
}

/** The House row: every action as one collapsed row at the end of the empty query, `count` of them; it opens them as a group (Tab,
 *  →, Enter) and never runs one (SPEC.md, *Rows*). */
const houseRow = n => ({kind: 'house', id: 'house', count: n});

/** The Needs you row: what only the owner can fix to keep the backends' data flowing (env.needs: each backend's `GET /v1/needs`, spaceport
 *  shared/backend/needs.md), `count` of them, first on the empty query while there are any; it opens them as the Needs you group (Tab, →,
 *  Enter). A need as a row, its id `need:<need id>`. */
const needsRow = n => ({kind: 'needs', id: 'needs', count: n});
const needRow = n => ({kind: 'need', id: `need:${n.backend && n.backend !== 'bridge' ? `${n.backend}/` : ''}${n.id}`, need: n});
const needText = n => [n.title, n.detail, n.backend, n.source, n.action?.label, n.action?.command].filter(Boolean).join(' ');

/** A one-time code as a row (env.codes: every owner host’s codes.list, the last 15 minutes' codes, newest first; SPEC.md, *Codes*), its id
 *  `code:<code id>`; the empty query's first rows, at most MAX.codes. Enter copies it (effect `copyCode`), nothing opens or views it. */
const codeRow = c => ({kind: 'code', id: `code:${c.id}`, code: c});

/** What a recent item is searched by: its preview, name, link and peers. */
const recentText = i => [i.preview, i.name, i.link, ...(i.peers ?? [])].filter(Boolean).join(' ').toLowerCase();
/** An action matches when every word starts (or nearly starts) a word of its title or subtitle. */
const actionMatch = (ws, a) => ws.every(w => words(`${a.title} ${a.subtitle ?? ''}`).some(t => t.startsWith(w) || (t[0] === w[0] && near(t, w))));
/** A Recent item, a group's member: every word is in its text or nearly starts one of its words. */
const textMatch = (ws, text) => { const t = text.toLowerCase(), tw = words(t); return ws.every(w => t.includes(w) || tw.some(x => near(x, w))); };

/** A document as a group's row (a series member or alternate, an order's mail, a cluster's, a day's, a subject's or a Related
 *  group's document): a document row, with the `reason` it is there or the period it is an `alternateOf`. */
function memberRow(document, extra = {}) {
  return {kind: 'document', id: `doc:${document.id}`, result: {kind: 'document', title: document.title, document}, ...extra};
}

/** The group a row holds (SPEC.md, *Groups*), else null: `{key, title}` and `rows` (inline: a series' members and their alternates,
 *  an order and its mails, numbers and links, a device's documents), or `carry` (a section: the query goes along). Collection entities open their canonical detail. */
export function groupOf(row) {
  const g = groupBy(row);
  // a row that views its own document (an event, a device or plant, a trip) opens a group only when it holds more than one row: one
  // item is on the row's own view, never behind a `1 ›`
  return g?.rows && SELF_VIEWED.has(row.kind) && g.rows.length < 2 ? null : g;
}
const SELF_VIEWED = new Set(['event', 'thing', 'trip']);
function groupBy(row) {
  switch (row?.kind) {
    case 'series': {
      const type = row.result.document.type;
      return {key: `series:${row.series.key}`, title: row.series.title, rows: row.series.members.flatMap(m => [
        memberRow({id: m.id, title: m.title, type, period: m.period, source: m.source, url: m.url}),
        ...(m.alternates ?? []).map(a => memberRow({id: a.id, title: a.title, type, period: m.period, source: a.source, url: a.url},
          {alternateOf: m.period ? periodLabel(m.period) : m.title}))])};
    }
    case 'cluster': return null;
    case 'topic': return {key: `topic:${row.topic.key}`, title: row.topic.title, rows: (row.topic.results ?? []).map(foundRow)};
    case 'area': return {key: `area:${row.area.key}`, title: row.area.title, rows: (row.area.results ?? []).map(foundRow)};
    case 'trips': return {key: `trips:${row.trips.key}`, title: row.trips.title, rows: (row.trips.results ?? []).map(foundRow)};
    case 'events': return {key: `events:${row.events.key}`, title: row.events.title, rows: (row.events.results ?? []).filter(shows).map(foundRow)};
    // a count bridge answered (an answer carrying `tally`: how many times we ordered from a store): what it counted, its orders
    case 'answer': return row.result.tally ? {key: `tally:${row.result.tally.key}`, title: row.result.tally.title, rows: (row.result.tally.results ?? []).map(foundRow)} : null;
    case 'day': return {key: `day:${row.day.date}`, title: row.result.title, rows: [...(row.day.results ?? []).map(foundRow), ...photosMember(row)]};
    case 'event': return {key: `event:${row.event.id}`, title: row.result.title, rows: [
      ...(row.event.attendees ?? []).map(a => foundRow(a.document ? a : {kind: 'none', title: [a.name, a.email].filter(Boolean).join(' · ')})),
      ...(row.event.documents ?? []).map(foundRow)]};
    case 'thing': return collectionTarget(row.result ?? row) ? null : {key: `thing:${row.thing.id}`, title: row.thing.name ?? row.result.title, rows: (row.thing.documents ?? []).map(d => memberRow(d, d.reason ? {reason: d.reason} : {}))};
    // Trips keep their confirmations and document groups; people open the shared profile.
    case 'trip': {
      const e = row[row.kind], d = row.result.document;
      return {key: `${row.kind}:${e.id}`, title: row.result.title || e.name, rows: [
        ...(e.ids ?? []).map(x => ({kind: 'identifier', id: `identifier:${x.value}`, result: {kind: 'identifier', title: x.title, value: x.value, document: d}})),
        ...(e.documents ?? []).map(m => memberRow(m, m.reason ? {reason: m.reason} : {})), ...photosMember(row)]};
    }
    case 'document': {
      const d = row.result.document, o = d.order;
      return d.mails?.length || o?.links?.length || o?.ids?.length ? {key: `order:${d.id}`, title: d.title,
        rows: [memberRow(d), ...(d.mails ?? []).map(m => memberRow({type: 'mail', source: 'gmail', ...m})),
          ...(o?.ids ?? []).map(x => ({kind: 'identifier', id: `identifier:${x.value}`, result: {kind: 'identifier', title: x.title, value: x.value, document: d}})),
          ...(o?.links ?? []).map(x => ({kind: 'link', id: `link:${x.url}`, result: {kind: 'link', title: x.title, value: x.url, document: d}}))]} : null;
    }
    // a flightplan item's snooze choices (SPEC.md, *Flightplan in Find*)
    case 'todo': case 'task': case 'epic': return row.result.snooze?.length ? {key: `snooze:${row.item.id}`, title: row.item.title,
      rows: row.result.snooze.map(c => ({kind: 'snooze', id: `snooze:${row.item.id}:${c.key}`, result: {title: c.label, subtitle: c.hint}, choice: c, item: row.item}))} : null;
    case 'needs': return {key: 'section:needs', title: 'Needs you'};
    case 'need': return {key: 'section:needs', title: 'Needs you', carry: true};
    case 'house': return {key: 'section:actions', title: 'House'};
    case 'action': return {key: 'section:actions', title: 'House', carry: true};
    case 'recent': return {key: 'section:recent', title: 'Recent', carry: true};
  }
  return null;
}

/** A row's photos (`withPhotos`) as the last member of its group: Enter shows them all. */
const photosMember = row => row.photos ? [{kind: 'photos', id: `photos:${row.photos.title}`, result: {kind: 'photos', title: row.photos.title}, photos: row.photos}] : [];

/** A row's group unless it is one already open (a section's rows inside that section). */
const groupIn = (state, row) => { const g = groupOf(row); return g && !(state.scopes ?? []).some(sc => sc.key === g.key) ? g : null; };

/** A group member's searchable text: title, type, period or date as shown, source, reason, the period it is an alternate of; a
 *  series (a topic's account) its title and span. */
const memberText = r => {
  if (['person', 'trip', 'event', 'day', 'none', 'snooze', 'todo', 'task', 'epic', 'photos'].includes(r.kind)) return `${r.result.title} ${r.result.subtitle ?? ''}`;
  if (r.kind === 'series') { const l = seriesLines(r.series); return `${l.title} ${l.subtitle}`; }
  if (r.kind === 'cluster') { const l = clusterLines(r.cluster); return `${l.title} ${l.subtitle}`; }
  const d = r.result.document; return [r.kind === 'document' ? d.title : `${r.result.title} ${r.result.value}`, docSubtitle(d), sourceName(d.source), r.reason, r.alternateOf].filter(Boolean).join(' ');
};

/** Filter full membership before paging; only the visible page becomes document rows. */
function scopeWindow(scope, query, env) {
  const ws = words(query);
  let records, make = item => item;
  if (scope.key === 'section:actions') records = (env.actions ?? []).filter(a => actionMatch(ws, a)).map(actionRow);
  else if (scope.key === 'section:needs') records = (env.needs ?? []).filter(n => textMatch(ws, needText(n))).map(needRow);
  else if (scope.key === 'section:recent') records = (env.recent ?? []).filter(i => textMatch(ws, recentText(i))).map(recentRow);
  else if (scope.rows) records = byPicks(scope.rows.filter(row => textMatch(ws, memberText(row))), env.picks);
  else {
    records = (env.groups?.[scope.key]?.items ?? []).filter(item => {
      const d = item.document;
      return d && textMatch(ws, [d.title, docSubtitle(d), sourceName(d.source), item.reason].filter(Boolean).join(' '));
    });
    records = [...records].sort((a, b) => (env.picks?.[`doc:${b.document.id}`] ?? 0) - (env.picks?.[`doc:${a.document.id}`] ?? 0));
    make = item => memberRow(item.document, item.reason ? {reason: item.reason} : {});
  }
  const range = pageRange(records.length, scope.page);
  return {...range, items: records.slice(range.start, range.end).map(make)};
}
export function groupWindow(state, env) {
  const scope = state.scopes?.at(-1);
  return scope ? scopeWindow(scope, state.query, env) : null;
}
const scopeRows = (scope, query, env) => scopeWindow(scope, query, env).items;

/** Bundled navigation's entries and their pages, each with the names Find reaches it by (nav `find.words`; a collection its label
 *  too). */
export const findEntries = (nav = []) => nav.flatMap(p => [p, ...(Array.isArray(p.pages) ? p.pages : [])])
  .map(p => ({entry: p, names: [...(p.collection === true ? [p.label] : []), ...(Array.isArray(p.find?.words) ? p.find.words : [])]}));
/** Collections and pages use the same word/prefix/typo matching as commands, with their names from bundled navigation (`collections`
 *  alone: every collection). */
const PLACE_WORDS = ['open', 'show', 'find', 'browse', 'my', 'all', 'the', 'collection', 'collections'];
function collectionRows(query, nav = []) {
  const ws = words(query).filter(w => !PLACE_WORDS.includes(w));
  if (!ws.length && !/\bcollections?\b/i.test(query)) return [];
  return findEntries(nav).filter(({entry, names}) => ws.length ? names.length && ws.every(w => names.some(name => words(name).some(t => near(t, w))))
    : entry.collection === true)
    .map(({entry}) => ({kind: 'collection', id: `collection:${entry.id}`, collection: entry}));
}

/** Whether the words name a collection outright (SPEC.md, *Rows*: it leads): its name, word for word, either number (`camera`,
 *  `all cameras`); not a word more (`garage camera` is a camera's, not the Cameras'), and not an alias (`tax return` is a series'). */
const one = w => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
function namesCollection(query, p) {
  const ws = words(query).filter(w => !PLACE_WORDS.includes(w)).map(one).join(' ');
  return !!ws && words(p.label).map(one).join(' ') === ws;
}

// A collection record's names (SPEC.md, *Rows*): the row's title and its entity's name, nickname, make, model, brand, street and
// aliases; the words a query must reach for the record to lead.
const RECORDS = ['person', 'vehicle', 'property', 'insurance', 'paper', 'packet', 'cluster', 'thing'];
const nameWords = v => String(v).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function recordNamed(ws, row) {
  const r = row.result ?? {};
  if (!ws.length || !collectionTarget(r)) return false;
  const e = RECORDS.map(f => r[f]).find(x => x && typeof x === 'object') ?? {};
  const names = [r.title, e.name, e.nickname, e.make, e.model, e.brand, e.address, e.street, e.insurer, ...(Array.isArray(e.aliases) ? e.aliases : [])]
    .filter(v => typeof v === 'string' || typeof v === 'number').flatMap(nameWords);
  // every word names it: a whole word, or (3 characters on) a word's start or one typo from it
  return ws.flatMap(nameWords).every(w => names.some(t => t === w || (w.length >= 3 && near(t, w))));
}

/** All People remain searchable; only the current 40 contacts become palette rows or keyboard candidates. */
export function peopleWindow(state, env) {
  return pageRange((env.found?.[state.query.trim()] ?? []).length, state.peoplePage);
}

// What a found entry can be besides a document, an identifier or a link: what the words name (SPEC.md, *Groups*, *Things*, *People
// and trips*, *Series*).
const ENTRIES = new Set(['person', 'thing', 'trip', 'trips', 'event', 'events', 'day', 'topic', 'area', 'series', 'cluster']);
/** Whether the words name this person: every word starts (or nearly starts) a word of the name or aliases (SPEC.md, *Person card*). */
export const namesPerson = (row, ws) => row?.kind === 'person' && ws.length > 0 && ws.every(w => [row.person.name ?? row.result.title ?? '', ...(Array.isArray(row.person.aliases) ? row.person.aliases : [])].some(name => words(name).some(t => near(t, w))));
const TALK = new Set(['messages', 'mail', 'email', 'text', 'texts']);
/** What the person card shows besides its chips (SPEC.md, *Person card*): the next event among the rows found with them that names or
 *  lists them (its row), their latest conversation and their latest other document: `{event, conversation, paper}`, each or null. */
export function cardPicks(row, rows = [], now = Date.now()) {
  const person = row.person ?? {}, name = String(person.name ?? row.result?.title ?? '').toLowerCase();
  const event = rows.filter(r => r.kind === 'event' && Date.parse(r.event.end ?? r.event.start) >= now
    && ((name && String(r.result.title ?? '').toLowerCase().includes(name)) || (r.event.attendees ?? []).some(a => a.person?.id != null && a.person.id === person.id)))
    .sort((a, b) => Date.parse(a.event.start) - Date.parse(b.event.start))[0] ?? null;
  const seen = new Set(), documents = [...(person.conversations ?? []), ...(person.mails ?? []), ...(person.documents ?? []), ...(person.papers ?? [])]
    .filter(d => d?.id != null && !seen.has(String(d.id)) && seen.add(String(d.id))).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const talk = d => d.reason === 'texts' || TALK.has(String(d.type ?? '').toLowerCase());
  return {event, conversation: documents.find(talk) ?? null, paper: documents.find(d => !talk(d)) ?? null};
}
/** The first person the words name leads as the person card (`card`, with what it shows: `picks`); the rest follow in their order,
 *  less the rows the card already shows (its event, conversation and document). */
function cardFirst(found, ws, now) {
  const i = found.findIndex(r => namesPerson(r, ws));
  if (i < 0) return found;
  const picks = cardPicks(found[i], found, now);
  const shown = new Set([picks.event?.id, ...[picks.conversation, picks.paper].filter(Boolean).map(d => `doc:${d.id}`)]);
  return [{...found[i], card: true, picks}, ...found.filter((r, j) => j !== i && !shown.has(r.id))];
}

/** Each row's place once a full answer replaces the words phase's rows (`order`, the ids shown): a row shown keeps its place; a new
 *  entry goes just before the first shown row (in the order shown) that the full answer puts after it, so a person or the more
 *  events bridge leads with are never pushed below every document the words found, but never above the selected row (`anchor`:
 *  the chosen one, else the one the words phase selected by itself), which stays where it was under the cursor; any other new
 *  row, and an entry the full answer puts after every shown row, follows the shown rows. */
function settled(rows, order, anchor = null) {
  const shown = new Map(order.map((id, i) => [id, i])), entries = new Map(), held = shown.get(anchor) ?? -1;
  let next = order.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (shown.has(r.id)) next = Math.min(next, shown.get(r.id));
    else if (ENTRIES.has(r.kind) && next < order.length) entries.set(r.id, Math.max(next - 0.5, held + 0.5));
  }
  return r => shown.get(r.id) ?? entries.get(r.id) ?? order.length;
}

/** The records the words name, one section per collection (its `lead`), each where its first record is: bridge's order mixes
 *  them (a cluster, the products, the car, another cluster), and each run would repeat its collection's label. */
function byLead(named) {
  const leads = [...new Set(named.map(r => r.lead))];
  return leads.flatMap(lead => named.filter(r => r.lead === lead));
}

/** A none row (`Nothing about “…”`, `No 2024 W-2`) says what bridge did not find: it leads its results, else it is left out (rows
 *  before it matched: `fp-1701` once tied a photo's rating plate ahead of it, and the line sat between results). */
const told = results => results.filter((r, i) => r.kind !== 'none' || results.slice(0, i).every(x => x.kind === 'none'));

/** The rows for a state: an open group's; else the codes, the Needs you row, Recent and the House row when the query is empty (no
 *  action is one key from running); else Ask, the collection records the words name, commands, actions, found, Recent's matches
 *  (SPEC.md, *Rows*). */
export function rows(state, env) {
  const scope = state.scopes?.at(-1);
  if (scope) return scopeRows(scope, state.query, env);
  if (state.answer) return (state.answer.citations ?? []).map(c => ({kind: 'citation', id: `citation:${c.id}`, citation: c}));
  const q = state.query.trim(), ws = words(q);
  if (!q) return [...(env.codes ?? []).slice(0, MAX.codes).map(codeRow), ...(env.landingExpanded ? (env.needs ?? []).map(needRow) : env.needs?.length ? [needsRow(env.needs.length)] : []), ...(env.recent ?? []).map(recentRow), ...(env.landingExpanded ? (env.actions ?? []).map(actionRow) : env.actions?.length ? [houseRow(env.actionsTotal ?? env.actions.length)] : [])];
  if (/^people(?:\s|:|$)/i.test(q)) { const page = peopleWindow(state, env); return [...(env.found?.[q] ?? []).slice(page.start, page.end).map(foundRow), ...collectionRows(q, env.nav)]; }
  if (noteText(q) != null) return [{kind: 'command', id: 'note', title: 'Add note', effect: {type: 'note', text: noteText(q)}}];
  if (env.capture && captureText(q) != null) return captureRows(captureText(q), env.capture);
  // a query of punctuation alone (`?`) has no words: nothing to match but Ask and found
  const cmds = !ws.length || env.commands === false ? [] : byPicks(commands(env.targets ?? []).filter(c => ws.every(w => words(c.title).some(t => near(t, w)))), env.picks).slice(0, MAX.commands);
  const lead = cmds.some(c => near(words(c.title)[0], ws[0]));
  const actions = !ws.length ? [] : (env.actions ?? []).filter(a => actionMatch(ws, a)).slice(0, MAX.actions).map(actionRow);
  const order = env.foundOrder?.[q];
  const results = told(collapse(env.found?.[q] ?? []));
  // a question Deck's find rules answered (every result `rule`: SPEC.md, *Flightplan in Find*): all of its answer in its order, Ask after it
  const ruled = results.length > 0 && results.every(r => r.rule), ask = isQuestion(q) ? [{kind: 'ask', id: 'ask', query: q}] : [];
  const most = ruled ? MAX.answered : MAX.found;
  let found = ruled ? results.slice(0, most).map(foundRow) : byPicks((order ? results : results.slice(0, most)).map(foundRow), env.picks);
  if (order) {
    // The full answer keeps the rows shown (their order frozen) and adds the rest after them, except the entries it puts ahead of
    // a row shown (a person, the more events, a vendor's series, a cluster…): each goes just before it, in its order.
    const at = settled(results.map(foundRow), order, state.selected ?? env.foundHeld?.[q]);
    found.sort((a, b) => at(a) - at(b));
  }
  if (!ruled) found = cardFirst(found, ws, env.now ?? Date.now());
  // what is not there (a none row bridge led with) stays first, whatever a pick or a person moved up
  found = [...found.filter(r => r.kind === 'none'), ...found.filter(r => r.kind !== 'none')].slice(0, most);
  // a collection record the words name (a car by its model, a person by name, a property by its street) leads, above the actions:
  // Enter opens its page, never runs an action
  let named = ruled ? [] : found.filter(r => recordNamed(ws, r));
  found = found.filter(r => !named.includes(r));
  named = byLead(named.map(r => ({...r, lead: collectionTarget(r.result).collection})));
  const recent = !ws.length ? [] : (env.recent ?? []).filter(i => textMatch(ws, recentText(i))).slice(0, MAX.recent).map(recentRow);
  // a collection the words name outright (`cameras`) leads, above what it holds; one they only reach comes after what was found
  const places = collectionRows(q, env.nav), placed = ruled ? [] : places.filter(c => namesCollection(q, c.collection));
  return [
    ...(ruled ? [] : ask),
    ...placed, ...named, ...(lead ? cmds : []), ...actions, ...found, ...places.filter(c => !placed.includes(c)), ...(ruled ? ask : []), ...recent, ...(lead ? [] : cmds),
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
  // the row the words phase selected by itself stays selected once the full answer replaces its rows (its card, the hint and Enter
  // do not change under the person), while it is shown
  const held = state.answer ? -1 : list.findIndex(r => r.id === env.foundHeld?.[state.query.trim()]);
  if (held >= 0) return held;
  // a line with nothing to view is never selected by itself, nor a house action (Enter never runs one the person did not choose);
  // nor anything when a flightplan row leads (its Enter is a write): Down or a click chooses it
  const first = list.findIndex(r => !line(r) && r.kind !== 'action');
  return first >= 0 && PLAN.has(list[first].kind) ? -1 : first;
}

/** A row that is only a line to read: bridge's none without a document, a capture whose reading asks which one. */
const line = r => (NOTES.has(r.kind) && !r.result.document) || (r.kind === 'capture' && !!r.ask);

export const initial = () => ({query: '', selected: null, confirm: null, answer: null, chip: null, scopes: []});

/** The box's text replaced as a whole (typing, Backspace or a paste in the app's own box): as typing it, the selection, an answer,
 *  a focused chip and a pending confirmation go. An open group stays (its box filters it). */
export const edit = (state, text) => ({...initial(), ...state, query: text, peoplePage: 0, scopes: (state.scopes ?? []).map((scope, i) => i === state.scopes.length - 1 ? {...scope, page: 0} : scope), selected: null, answer: null, chip: null, confirm: null});

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

/** Whether a row opens in the viewer (SPEC.md, *Viewer*): a found document, a series, a cluster (its best-tied document), a
 *  citation, a thing (its view: bridge's `pages` of its document), a Recent image or file. */
export const viewable = row => ['document', 'series', 'cluster', 'citation', 'thing', 'person', 'trip', 'event'].includes(row?.kind) || noted(row) || (row?.kind === 'recent' && ['image', 'file'].includes(row.item.kind));

/** A row → opens: a cluster, an order, a topic, an area, a thing, a trip, the more trips, the House or the Needs you row (a
 *  series' → moves its chips). */
const drills = row => row?.kind === 'house' || row?.kind === 'needs' || /^(cluster|order|topic|area|thing|trip|trips|event|events|day|tally|snooze):/.test(groupOf(row)?.key ?? '');

/** A row whose Enter opens its group, its chart heading it (SPEC.md, *Topics*): a cluster, the House or the Needs you row, a topic,
 *  an area, the more trips, and a utility's or a vendor's series (`series.chart`) with no chip focused (a focused chip's Enter views
 *  that bill). */
const opens = (row, state) => ['cluster', 'house', 'needs', 'topic', 'area', 'trips', 'events', 'day'].includes(row?.kind) || (row?.kind === 'series' && !!row.series.chart && chipOf(state, row) == null);

/** Whether the model takes Space, Left or Right from the search box (true) or the box keeps it (false: a space typed, the caret
 *  moved). Other keys: always the model's. A pending confirmation does not change it: Space cancels it and views. */
export function takes(state, env, k) {
  const row = chosen(state, env);
  if (k === 'Space') return viewable(row);
  if (k === 'Left') return row?.kind === 'series';
  if (k === 'Right') return !!collectionTarget(row?.result ?? row) || row?.kind === 'person' || row?.kind === 'series' || (drills(row) && !!groupIn(state, row));
  return true;
}

/** Space's and Enter's effect: the viewer, on a document (`id`, with the query for its match) or a Recent item (`recent`). */
function view_(row, state) {
  const query = (state.scopes?.length ? state.scopes[0].back.query : state.query).trim();
  // a thing with a shared identity opens its hub (`/things#<UUID>`, ui/contract/things.md *Physical thing page*), as a record does
  const collection = collectionTarget(row?.result ?? row) ?? (row?.kind === 'thing' && physicalThingId(row.thing?.thingId) ? {collection: 'things', id: row.thing.thingId} : null);
  const photos = row?.photos ? {photos: row.photos} : {};
  if (collection) return {type: 'view', ...(row.result?.document?.id != null ? {id: row.result.document.id} : {}), query, collection, ...photos};
  switch (row.kind) {
    case 'document': case 'cluster': case 'thing': case 'person': case 'trip': case 'event': case 'answer': case 'none': return row.result.document ? {type: 'view', id: row.result.document.id, query, ...photos} : null;
    // a photo set (SPEC.md, *Photos*): all of it in the viewer
    case 'photos': return {type: 'view', photos: row.photos};
    case 'series': return {type: 'view', id: member(row, state).id, query};
    case 'citation': return {type: 'view', id: row.citation.id, query};
    case 'recent': return {type: 'view', recent: row.item.id};
  }
  return null;
}

/** Sources whose documents have no original to download (bridge's `/v1/doc/<id>/file`): mail, texts, house records, orders, ref rows, calendar events. */
const NO_FILE = new Set(['gmail', 'messages', 'house', 'house-model', 'amazon', 'ref', 'bridge', 'calendar']);
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

/** Motorized controls always ask, even when an older bridge omits its confirmation flag. */
export const actionNeedsConfirmation = action => !!action.confirm ||
  [action.domain, action.id?.split('.')[0]].some(domain => ['cover', 'lock', 'fan', 'valve', 'vacuum', 'climate'].includes(domain));

/** Enter's effect on a row (a cluster's and the House row's open their group: `step`): a document-like row views it (a download is
 *  the viewer's Open file). */
function primary(row, state) {
  switch (row.kind) {
    case 'cluster': case 'series': case 'document': case 'citation': case 'thing': case 'person': case 'trip': case 'event': case 'answer': case 'none': case 'photos': return view_(row, state);
    case 'ask': return {type: 'ask', query: row.query};
    case 'command': return row.effect;
    case 'action': return actionNeedsConfirmation(row.action) ? {type: 'confirm', what: 'act', id: row.action.id} : {type: 'act', id: row.action.id};
    case 'identifier': return {type: 'copy', value: row.result.value, sensitive: true};
    case 'link': return {type: 'copy', value: row.result.value, sensitive: false};
    case 'recent': return viewable(row) ? view_(row, state) : {type: 'copyRecent', id: row.item.id};
    case 'need': return needEffect(row.need);
    // the host puts the code on the clipboard from its own memory (codes.copy), kept out of clipboard history
    case 'code': return {type: 'copyCode', id: row.code.id};
    // flightplan (SPEC.md, *Flightplan in Find*, *Capture*): done, a snooze choice, the capture added (with a choice of its reading)
    case 'todo': case 'task': case 'epic': return planOpen(row) ? {type: 'done', id: row.item.id} : null;
    // a project (SPEC.md, *Flightplan in Find*): its epic on the Board
    case 'project': return {type: 'open', url: row.result.url};
    // an item or a change an exact id named: its page (the site's `/flightplan/FP-n`, `/todo/FP-n`, `/flightplan/change/…`), on a
    // desktop the viewer's pane
    case 'item': case 'change': return {type: 'view', plan: planOf(row)};
    case 'collection': return {type: 'open', url: row.collection.url};
    case 'snooze': return {type: 'snooze', id: row.item.id, until: row.choice.until};
    case 'capture': return row.ask ? null : {type: 'capture', text: row.text};
    case 'choice': return {type: 'capture', text: row.text, choice: row.choice};
  }
  return null;
}

/** What the viewer opens for an item's or a change's row: its page, its GitHub link, its title, the item or the change. */
const planOf = row => ({path: row.result.path, url: row.result.url ?? null, title: row.result.title, ...(row.kind === 'item' ? {item: row.item} : {change: row.result.change})});

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
    case 'todo': case 'task': case 'epic': return row.result.url ? {type: 'open', url: row.result.url} : null;
    case 'project': return row.result.issue ? {type: 'open', url: row.result.issue} : null;
    case 'item': case 'change': return row.result.url ? {type: 'open', url: row.result.url} : null;
    case 'series': return {type: 'document', id: member(row, state).id, file: false};
    case 'cluster': return {type: 'map', by: 'cluster', value: row.cluster.id};
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

/** A source as people name it, the one map for every place that shows one (bridge's `document.source`, a citation's or a need's
 *  `source`, a person's `sources`): the source chip and the hint's Mod+Enter (SPEC.md, *Row kinds*), the source filter, needs,
 *  a duplicate person's From. `kb` and `ref` keep their own lowercase names. Unknown names stay as they are; none is null. */
export const SOURCES = {seafile: 'Seafile', immich: 'Immich', gmail: 'Gmail', calendar: 'Calendar', messages: 'Messages', signal: 'Signal',
  whatsapp: 'WhatsApp', imessage: 'iMessage', sms: 'Text messages', email: 'Email', contacts: 'Contacts', people: 'People', kb: 'kb',
  notes: 'Notes', papers: 'Papers', bills: 'Bills', house: 'House', 'house-model': 'House', amazon: 'Amazon', delivery: 'Delivery', ref: 'ref',
  github: 'GitHub', bridge: 'Deck', kinfolk: 'Family tree', household: 'Household'};
export const sourceName = s => s ? SOURCES[String(s).toLowerCase()] ?? String(s) : null;
const openIn = s => sourceName(s) ? `Open in ${sourceName(s)}` : 'Open source';

/** A series member's source (bridge's `members[].source`), else the document carrying the series': the row's chip names the
 *  newest's, the hint the member Mod+Enter opens (the focused chip's). */
const seriesSource = (row, i = 0) => row.series.members[i]?.source ?? row.result.document.source;

/** Labels for the hint line: Enter's and Mod+Enter's per row. */
function labels(row, state) {
  switch (row.kind) {
    // inside a topic, whose chart already shows, a utility's Enter opens that one account
    case 'series': { const c = chipOf(state, row); return [c == null ? (row.series.chart ? (state.scopes?.at(-1)?.key?.startsWith('topic:') ? 'Show account' : 'Show chart') : 'View newest') : `View ${seriesLines(row.series).chips[c].label}`, openIn(seriesSource(row, c ?? 0))]; }
    case 'cluster': return ['View', 'Open map'];
    case 'photos': return ['View all', null];
    case 'topic': return ['Show chart', null];
    case 'area': case 'trips': case 'events': case 'day': return ['Show all', null];
    case 'house': case 'needs': return ['Show all', null];
    case 'need': { const a = row.need.action; return [needEffect(row.need) ? a.label || {url: 'Open', op: 'Run', command: 'Copy'}[a.kind] : null, null]; }
    case 'code': return ['Copy', null];
    case 'todo': case 'task': case 'epic': return [planOpen(row) ? 'Done' : null, row.result.url ? 'Open issue' : null];
    case 'collection': return [row.collection.collection === true ? 'Open collection' : 'Open page', null];
    case 'project': return ['Open board', row.result.issue ? 'Open issue' : null];
    case 'item': return ['Open', row.result.url ? 'Open issue' : null];
    case 'change': return ['Open', row.result.url ? 'Open in GitHub' : null];
    case 'snooze': return ['Snooze', null];
    case 'capture': return [row.ask ? null : 'Add', null];
    case 'choice': return ['Add', null];
    case 'ask': return ['Ask', null];
    case 'command': return [row.effect.type === 'note' ? 'Add' : 'Run', null];
    case 'action': return ['Run', null];
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
    // a record shows its card in place (SPEC.md, *Record card*): → moves into it, as Tab
    if (collectionTarget(r.result ?? r)) return [s, k === 'Right' ? {type: 'card', id: r.id} : null];
    if (r.kind === 'person') return [s, view_(r, s)];
    if (r.kind !== 'series') return openGroup(s, r, groupIn(s, r));
    const n = r.series.members.length, c = chipOf(s, r);
    s.chip = k === 'Right' ? Math.min((c ?? -1) + 1, n - 1) : c ? c - 1 : -1;
    return [s, null];
  }
  // a record's card (the person card, any selected record: SPEC.md, *Record card*): Tab moves into it (the view's focus; effect
  // `card`), Enter opens the record
  if (k === 'Tab' && (row?.card || collectionTarget(row?.result ?? row))) return [s, {type: 'card', id: row.id}];
  if (k === 'Tab') { if (row?.kind === 'person') return [s, view_(row, s)]; const g = groupIn(s, row); return g ? openGroup(s, row, g) : [s, null]; }
  if (k === 'Shift+Tab') return s.scopes.length ? pop(s) : [s, null];
  if (k.startsWith('Group:')) { const key = k.slice(6); if (key.startsWith('cluster:')) return [s, {type: 'view', collection: {collection: 'clusters', id: key.slice(8)}, query: s.query}]; return openGroup(s, null, {key, title: env.groups?.[key]?.title ?? key.slice(key.indexOf(':') + 1), load: true}); }
  if (k === 'Backspace' && s.scopes.length && !s.query) return pop(s);
  // with text in the box, Mod+Backspace, Mod+Delete and Mod+Shift+Backspace clear it, as one edit (SPEC.md, *Keys*)
  if (CLEARS.has(k) && s.query) return [edit(s, ''), null];
  const typed = k.startsWith('Type:') || k === 'Backspace' || k === 'Space';
  if (typed) {
    s.peoplePage = 0;
    s.scopes = s.scopes.map((scope, i) => i === s.scopes.length - 1 ? {...scope, page: 0} : scope);
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
      if (!collectionTarget(row.result ?? row) && opens(row, s)) { const g = groupIn(s, row); return g ? openGroup(s, row, g) : [s, null]; }
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

/** Whether Tab's group shows more than the rows do now: always for a series, cluster, order, topic, area, thing, trip or the House row; a section when rows
 *  of it are hidden (5 matching actions of more; Recent's 5 matches of more). */
function more(state, env, list, row) {
  const g = groupIn(state, row);
  if (!g) return false;
  if (!g.carry) return true;
  return scopeWindow(g, state.query, env).total > list.filter(r => r.kind === row.kind).length;
}

/** A pending confirmation's verb, the one word every place it shows uses (the row's button, the status line, the hint): an action's
 *  first word (`Unlock`), else Create link, Remove, Clear all. */
export function confirmVerb(confirm, env) {
  if (confirm?.what !== 'act') return {share: 'Create link', remove: 'Remove', clear: 'Clear all'}[confirm?.what] ?? 'Run';
  return String((env.actions ?? []).find(a => a.id === confirm.id)?.title ?? '').split(' ')[0] || 'Run';
}

/** The hint line: [key, label] pairs, at most four; Mod is ⌘ on the Mac, Ctrl on Windows. Esc is named only where nothing is
 *  selected (Close, Clear, Back) and on a confirmation (Cancel); the breadcrumb says an open group's Esc. Nothing selected: Down
 *  on an empty query, Ask when a query found nothing (the send keys are the commands bar's, never repeated here). */
export function hint(state, env) {
  if (state.confirm) return [['Enter', confirmVerb(state.confirm, env)], ['Esc', 'Cancel']];
  const list = rows(state, env), at = selection(state, env, list);
  if (at < 0) {
    if (state.scopes?.length) return [['Esc', state.query ? 'Clear' : 'Back']];
    if (state.answer) return [['Esc', 'Clear']];
    // flightplan's rows or house actions leading (never selected by themselves): Down chooses one
    if (state.query.trim()) return [...(list.some(r => PLAN.has(r.kind) || r.kind === 'action') ? [['Down', 'Select']] : []), ['Shift+Enter', 'Ask'], ['Esc', 'Clear']];
    return list.length ? [['Down', 'Select'], ['Esc', 'Close']] : [['Esc', 'Close']];
  }
  const row = list[at], [enter, mod] = labels(row, state);
  if (row.card) return [['Enter', 'Profile'], ...(mod ? [['Mod+Enter', mod]] : []), ['Tab', 'Contacts']];
  // a record: its card shows under it; Enter opens the whole record, Tab moves into the card. Space is an alias for Enter.
  if (collectionTarget(row.result ?? row)) return [['Enter', row.kind === 'person' ? 'Profile' : 'Open'], ...(mod ? [['Mod+Enter', mod]] : []), ['Tab', 'Card']];
  return [ ...(enter ? [['Enter', enter]] : []), ...(mod ? [['Mod+Enter', mod]] : []),
    ...(!opens(row, state) && more(state, env, list, row) ? [['Tab', PLAN.has(row.kind) ? 'Snooze' : 'Show all']] : [])];
}

/** The viewer's Related rail from bridge's `/v1/related/<id>` (SPEC.md, *Related*): `chips`, where else to go (its day, clusters,
 *  rarest subjects; each a group key: `day:<date>`, `cluster:<id>`, `subject:<name>`), then `groups` in bridge's order (an empty one
 *  left out; an unknown kind by its label): `{key: related:<id>:<kind>, kind, label, count, items: [{id: doc:<id>, title, reason,
 *  document}], more}`, more being how many the group holds beyond its items (its own list, Tab). */
export function relatedRail(related) {
  const id = related.document?.id;
  const chips = [
    ...(related.day ? [{kind: 'day', key: `day:${related.day}`, label: dateLabel(related.day)}] : []),
    ...(related.clusters ?? []).map(p => ({kind: 'cluster', key: `cluster:${p.id}`, label: p.name})),
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
