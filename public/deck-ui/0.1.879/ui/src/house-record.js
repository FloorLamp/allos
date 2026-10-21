// A house record in Deck's Things full view (contract/things.md *House record*): bridge's record of a thing of the house (bridge
// CONTRACT.md *House records*), no DOM. What it shows (facts, warranty, installer, breakers, events newest first, photos), its open
// items (bridge's suggestions, the questions of the record, its breakers and events, the fields its kind still wants, a panel's
// unverified breakers) and the edits: each a direct write to bridge, whose answer is the record as it now is.
import {dateText, fieldLabel} from './format.js';
import {describeFailure} from './failure.js';

/** Event types a record's event takes (bridge's house checks; planting is plant work, from /plants). */
export const EVENT_TYPES = ['leak', 'repair', 'installation', 'removal', 'service', 'damage', 'pest', 'outage', 'inspection', 'other'];
/** The fields a kind may still want (`record.missing`, bridge's), as Fill in names them. */
export const FIELDS = {
  model: {label: 'Model', hint: 'As on the nameplate'},
  serial: {label: 'Serial', hint: 'As on the nameplate'},
  installed: {label: 'Install date', hint: 'YYYY, YYYY-MM or YYYY-MM-DD', inputMode: 'numeric'},
  location: {label: 'Location', hint: 'Where it is, e.g. basement, by the stair'},
};
const SUGGESTED = {docs: 'Manual or plan', receipts: 'Receipt', photos: 'Photo', serial: 'Serial', model: 'Model', installed: 'Install date',
  'warranty.until': 'Warranty until'};
const PARTIAL = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;
const list = value => value == null || value === '' ? [] : [].concat(value);
const at = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const DATE_HINT = 'YYYY, YYYY-MM or YYYY-MM-DD';

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, a real day, from 1900. */
export function partialDate(text) {
  const m = PARTIAL.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) < 1900) return false;
  if (!m[3]) return true;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.getUTCDate() === Number(m[3]);
}

/** A question (`to_confirm`) as text: the record's own words; a list (of text or `{question}`) is each one. */
export const questions = subject => list(subject?.to_confirm).map(q => typeof q === 'string' ? q : q?.question).filter(Boolean);

const yesNo = v => v == null ? null : v ? 'Yes' : 'No';
/** An editable fact: `path` the record's field (a dot into a table: `warranty.until`), `value` as shown, `raw` as edited, `as`
 *  (input, textarea, select with `options`), `date` (a partial date), `contact` (a phone or a site: `url` opens it). */
const fact = (record, path, label, {show = v => v, ...rest} = {}) => {
  const raw = at(record, path);
  return {path, label, raw: raw == null ? '' : String(raw), value: raw == null || raw === '' ? null : show(raw), ...rest};
};
const dated = {show: dateText, hint: DATE_HINT, inputMode: 'numeric', date: true};
const phone = {url: v => `tel:${String(v).replace(/[^\d+]/g, '')}`, inputMode: 'tel'};
const site = {show: v => String(v).replace(/^https?:\/\//, ''), url: v => /^https?:\/\//.test(v) ? v : `https://${v}`, inputMode: 'url'};

/** What the record says about the thing; `room` the thing's canonical room name (bridge's), never the record's room id, and not
 *  edited here (house-model's room registry names the rooms). Only what is known. */
export function recordFacts(thing) {
  const r = thing.house?.record ?? {};
  return [
    {label: 'Kind', value: r.kind ? fieldLabel(r.kind) : null},
    fact(r, 'make', 'Make'), fact(r, 'model', 'Model'), fact(r, 'serial', 'Serial'),
    {label: 'Room', value: thing.room},
    fact(r, 'location', 'Location'), fact(r, 'installed', 'Installed', dated), fact(r, 'manufactured', 'Manufactured', dated),
    fact(r, 'serves', 'Serves'), fact(r, 'size', 'Size'),
    ...(r.kind === 'panel' ? [fact(r, 'main_amps', 'Main breaker', {show: v => `${v} A`, inputMode: 'numeric', number: true})] : []),
  ].filter(f => f.value != null && f.value !== '');
}

const contact = (record, base, prefix) => [fact(record, `${base}.name`, `${prefix}name`), fact(record, `${base}.phone`, `${prefix}phone`, phone),
  fact(record, `${base}.web`, `${prefix}web`, site)].map(f => ({...f, label: f.label.charAt(0).toUpperCase() + f.label.slice(1)}));
/** The record's warranty (until, terms, transferable, registered, its contact), else bridge's from the purchase (not edited here). */
export function warrantyFacts(thing) {
  const r = thing.house?.record;
  if (!r?.warranty) return thing.warranty ? [{label: 'Until', value: thing.warranty.expires ? dateText(thing.warranty.expires) : null},
    {label: 'Terms', value: thing.warranty.terms}].filter(f => f.value) : [];
  return [fact(r, 'warranty.until', 'Until', dated), fact(r, 'warranty.terms', 'Terms', {as: 'textarea'}),
    fact(r, 'warranty.transferable', 'Transferable', {show: yesNo, as: 'select', options: [['true', 'Yes'], ['false', 'No']], boolean: true}),
    fact(r, 'warranty.registered', 'Registered', {show: v => typeof v === 'boolean' ? yesNo(v) : dateText(String(v))}),
    ...contact(r, 'warranty.contact', 'contact ')].filter(f => f.value != null && f.value !== '');
}
export const installerFacts = thing => thing.house?.record?.installer ? contact(thing.house.record, 'installer', '').filter(f => f.value) : [];

/** The value a fact's edit writes: '' removes it (null); a number, a yes/no and a date as bridge takes them. */
export function editValue(f, text) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  if (f.number) return Number.isFinite(Number(t)) ? Number(t) : t;
  if (f.boolean) return t === 'true';
  return t;
}

/** The start of an event's date (`2026-04-25/2026-04-27` → `2026-04-25`). */
const start = e => String(e.date ?? '').split('/')[0];
/** An event's when: `Apr 25, 2026`, a range `Apr 25, 2026 – Apr 27, 2026`. */
export const eventWhen = e => String(e.date ?? '').split('/').filter(Boolean).map(dateText).join(' – ');
/** The record's events, newest first (by their start; the same day by id). */
export const recordEvents = thing => [...(thing.house?.events ?? [])]
  .sort((a, b) => start(b).localeCompare(start(a)) || String(b.id).localeCompare(String(a.id)));

/** A panel's breakers in slot order (the left column, then the right; top to bottom). */
export function breakers(thing) {
  const slot = b => { const m = /^([LR])(\d+)$/.exec(String(b.slot ?? '')); return m ? [m[1], Number(m[2])] : ['Z', 0]; };
  return [...(thing.house?.breakers ?? [])].sort((a, b) => { const [x, i] = slot(a), [y, j] = slot(b); return x.localeCompare(y) || i - j; });
}
/** A breaker's line: `20 A · 2-pole · AFCI`. */
export const breakerLine = b => [b.amps ? `${b.amps} A` : null, b.poles > 1 ? `${b.poles}-pole` : null, b.type && b.type !== 'standard' ? b.type : null].filter(Boolean).join(' · ');

/** The record's photos: bridge's indexed photo documents for its Immich ids (`house.photos`), and how many it has not indexed. */
export function recordPhotos(thing) {
  const ids = list(thing.house?.record?.photos);
  const known = new Map((thing.house?.photos ?? []).filter(p => p?.document?.id != null).map(p => [p.id, p.document]));
  const shown = ids.filter(id => known.has(id)).map(id => ({...known.get(id), immich: id}));
  return {shown, missing: ids.length - shown.length};
}

/** The open items, one per subject: bridge's suggestions (Accept), the questions (Answer: the record's, a breaker's, an event's),
 *  the fields its kind still wants (Fill in: `record.missing`), a panel's breakers with no verified loads (Verify). A field bridge
 *  suggests a value for is that suggestion's item (`fill`: the field, "Fill in another"), never a second item; a field suggestion
 *  for a field the record now has is gone. Each `{key, kind, title, line}`. */
export function openItems(thing, {hidden = new Set()} = {}) {
  const record = thing.house?.record;
  if (!record) return [];
  const items = [], missing = list(record.missing).filter(f => FIELDS[f] && (record[f] == null || record[f] === '')), suggested = new Set();
  for (const s of thing.suggestions ?? []) {
    if (hidden.has(s.id) || (s.kind === 'field' && at(record, s.field) != null && at(record, s.field) !== '')) continue;
    const fill = s.kind === 'field' && FIELDS[s.field] && !suggested.has(s.field) ? s.field : null;
    if (fill) suggested.add(fill);
    items.push({key: `suggestion:${s.id}`, kind: 'suggestion', suggestion: s, fill,
      title: `${SUGGESTED[s.field] ?? fieldLabel(s.field ?? 'value')}: ${s.kind === 'link' ? s.document?.title ?? s.value : s.kind === 'photo' ? s.document?.title ?? 'from Photos' : s.value}`,
      line: [s.document?.title && s.kind === 'field' ? `From ${s.document.title}` : null, s.quote ? `“${s.quote}”` : null].filter(Boolean).join(' · ')});
  }
  const ask = (on, title, subject) => { const q = questions(subject); if (q.length) items.push({key: `answer:${on}`, kind: 'answer', on, title, line: q.join(' ')}); };
  ask('record', 'To confirm', record);
  for (const field of missing.filter(f => !suggested.has(f))) items.push({key: `field:${field}`, kind: 'field', field, title: `${FIELDS[field].label} unknown`, line: null});
  for (const b of breakers(thing)) {
    ask(`breaker:${b.slot}`, `Breaker ${b.slot}: to confirm`, b);
    if (!b.feeds) items.push({key: `breaker:${b.slot}`, kind: 'breaker', breaker: b, title: `Breaker ${b.slot}: loads not verified`,
      line: b.label ? `Panel label: “${b.label}”` : 'No label on the panel'});
  }
  for (const e of recordEvents(thing)) ask(`event:${e.id}`, `${e.title}: to confirm`, e);
  return items;
}
/** The Fill in a suggestion's "Fill in another" opens: its field. */
export const fillItem = item => ({key: `field:${item.fill}`, kind: 'field', field: item.fill});

/** An event's fields as its form edits them, and back: `notes` and `by` left out when empty, `resolved` only for a resolved event. */
export const eventForm = (e = {}) => ({title: e.title ?? '', date: e.date ?? '', type: e.type ?? 'repair', status: e.status ?? 'resolved',
  resolved: e.resolved ?? '', by: e.by ?? '', notes: e.notes ?? ''});
export function eventFields(form, {editing = false} = {}) {
  const errors = {}, v = Object.fromEntries(Object.entries(form).map(([k, x]) => [k, String(x ?? '').trim()]));
  if (!v.title) errors.title = 'A title is required';
  const dates = v.date.split('/');
  if (!v.date || dates.length > 2 || !dates.every(partialDate)) errors.date = 'A date from 1900 on, or a range start/end';
  if (v.resolved && !partialDate(v.resolved)) errors.resolved = 'A date from 1900 on';
  if (!EVENT_TYPES.includes(v.type)) errors.type = 'Choose what happened';
  if (!['open', 'resolved'].includes(v.status)) errors.status = 'Open or resolved';
  if (Object.keys(errors).length) return {errors};
  const out = {title: v.title, date: v.date, type: v.type, status: v.status};
  // an edit names every field the form holds (null removes one); a new event only what it has
  for (const k of ['by', 'notes']) if (v[k] || editing) out[k] = v[k] || null;
  if (v.status === 'resolved' && v.resolved) out.resolved = v.resolved; else if (editing) out.resolved = null;
  return {event: out};
}

/** Bridge's 400 `{error: "invalid", fields}` (web: the host's `fields`) as `{path: message}`; a key naming another subject
 *  (`<subject> <path>`) by its path. */
export function fieldErrors(error) {
  const fields = error?.fields && typeof error.fields === 'object' ? error.fields : null;
  if (!fields) return null;
  return Object.fromEntries(Object.entries(fields).filter(([, m]) => typeof m === 'string').map(([k, m]) => [k.split(' ').at(-1), m]));
}

/** A thing's record as Deck edits it: `house` (bridge's answer, replaced by every write's), `history`, the suggestions accepted here
 *  (`hidden`), each edit's state by its key (`{busy}`, `{error, fields?}`), and `saved` (the toast's moment). Writes need a gesture. */
export function createRecordEditor(host, thing) {
  const listeners = new Set(), state = new Map(), hidden = new Set();
  let stopped = false, historyRequest = null;
  const changed = () => { if (!stopped) for (const fn of listeners) fn(); };
  const id = thing.id;
  const editor = {
    house: thing.house, history: null, historyError: null, saved: 0, hidden,
    state: key => state.get(key) ?? null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The record now (its house as bridge last answered) for the view. */
    thing: () => ({...thing, house: editor.house}),
    async loadHistory() {
      historyRequest?.abort(); historyRequest = new AbortController();
      const {signal} = historyRequest;
      try {
        const answer = await host.call('bridge.things.record.history', {query: {id}}, {signal});
        if (!signal.aborted) { editor.history = Array.isArray(answer?.history) ? answer.history : []; editor.historyError = null; }
      } catch (error) {
        if (!signal.aborted) { editor.history = null; editor.historyError = ['not-set-up', 'unsupported', 'cancelled'].includes(error?.code) ? null : describeFailure('bridge', error); }
      }
      if (!signal.aborted) changed();
    },
    /** One write: `op` a bridge record op, `query` its path's ids past the thing's, `body`; true once bridge took it. */
    async write(key, op, query, body) {
      if (stopped || state.get(key)?.busy) return false;
      state.set(key, {busy: true}); changed();
      try {
        const answer = await host.call(op, {query: {id, ...query}, ...(body ? {body} : {})});
        if (stopped) return false;
        if (answer?.house) editor.house = answer.house;
        state.delete(key); editor.saved++;
        changed();
        editor.loadHistory();
        return true;
      } catch (error) {
        if (stopped) return false;
        state.set(key, {error: describeFailure('bridge', error), fields: fieldErrors(error)}); changed();
        return false;
      }
    },
    edit: (key, fields, extra = {}) => editor.write(key, 'bridge.things.record', {}, {fields, ...extra}),
    async accept(s, key) {
      const ok = await editor.write(key, 'bridge.things.record', {}, {suggestion: s.id});
      if (ok) { hidden.add(s.id); changed(); }
      return ok;
    },
    answer: (key, on, answer) => editor.write(key, 'bridge.things.record.answer', {}, {on, answer}),
    breaker: (key, slot, fields) => editor.write(key, 'bridge.things.record.breaker', {slot}, {fields}),
    addEvent: (key, event) => editor.write(key, 'bridge.things.record.event.add', {}, {event}),
    editEvent: (key, event, fields) => editor.write(key, 'bridge.things.record.event', {event}, {fields}),
    deleteEvent: (key, event) => editor.write(key, 'bridge.things.record.event.delete', {event}),
    clear(key) { state.delete(key); changed(); },
    stop() { stopped = true; historyRequest?.abort(); listeners.clear(); },
  };
  return editor;
}

/** A history entry's line: `Serial: — → EX50-4321`; a breaker or event added or removed (`*`) by what it is. */
export function historyLine(h) {
  const show = v => v == null || v === '' ? '—' : typeof v === 'object' ? (v.title ?? v.label ?? v.slot ?? 'it') : String(v);
  const what = h.subject?.startsWith('breaker:') ? `Breaker ${h.subject.split(':').at(-1)}` : h.subject?.startsWith('event:') ? 'Event' : null;
  if (h.field === '*') return `${what ?? 'Record'} ${h.old == null ? 'added' : h.new == null ? 'removed' : 'replaced'}: ${show(h.new ?? h.old)}`;
  const field = String(h.field ?? '').split('.').map(fieldLabel).join(' ');
  return `${[what, field].filter(Boolean).join(' · ')}: ${show(h.old)} → ${show(h.new)}`;
}
/** Who made a change, in words: a member's id as their name, the family network, a device by its name, the import. */
// the one-time import as `who` is in backquotes: tool/imports.mjs reads a quoted word right after that word as a module
export const historyWho = who => who === 'family' ? 'Family network' : who === `import` ? 'Imported' : String(who ?? '').startsWith('device:')
  ? `Device ${String(who).slice(7)}` : fieldLabel(String(who ?? 'Someone'));
