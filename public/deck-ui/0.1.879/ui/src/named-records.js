// The records a document names (its viewer's People & things), no DOM and no model call: bridge's collections (people, vehicles,
// properties, things) read once per host and kept a while, matched to the document's subjects (bridge.related's `subjects`, canonical
// names) and the names its title or place spells out whole (`Lee Example’s birthday` names Lee Example).
import {collectionTarget} from './collection-target.js';
import {entityOf} from './view/entity-link.js';
import {personPhoto} from './people.js';

const LISTS = ['bridge.people', 'bridge.vehicles', 'bridge.properties', 'bridge.things'];
/** How long the collections are kept per host before they are asked again. */
export const KEEP_MS = 10 * 60_000;
const kept = new WeakMap();

const wordsOf = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const same = (a, b) => a.length === b.length && a.every((w, i) => w === b[i]);
/** Whether `words` holds `name` (its words in order, whole). */
const holds = (words, name) => words.some((_, i) => same(words.slice(i, i + name.length), name));

/** A collection row's record ({kind, id, label, names: [[word]], photo?}), else null: its entity's name, aliases, nickname, make and
 *  model, address; a person's portrait (people.js `personPhoto`) when bridge has one. */
export function recordOf(row) {
  const target = collectionTarget(row), entity = target && entityOf(target);
  if (!entity) return null;
  const e = row.person ?? row.vehicle ?? row.property ?? row.thing ?? {};
  const label = e.name ?? row.title;
  if (!label) return null;
  const names = [label, e.contact, e.nickname, e.address, e.street, ...(Array.isArray(e.aliases) ? e.aliases : []),
    e.make && e.model ? `${e.make} ${e.model}` : null].filter(n => typeof n === 'string' && n.trim()).map(wordsOf).filter(n => n.length);
  const photo = row.person ? personPhoto(row.person) : null;
  return {...entity, label: String(label), names, ...(photo ? {photo} : {})};
}

/** Of `records` (recordOf's), those the document names, in the order it names them: a subject that is one of a record's names, or a
 *  name of two words or more that `text` (its title, its place) holds whole. Answers {records: [{kind, id, label}], subjects: [the
 *  subjects no record is]}. */
export function namedRecords(records, {subjects = [], text = []} = {}) {
  const out = new Map(), rest = [], words = [text].flat().map(wordsOf);
  const add = r => out.set(`${r.kind}:${r.id}`, {kind: r.kind, id: r.id, label: r.label, ...(r.photo ? {photo: r.photo} : {})});
  for (const s of subjects) {
    const w = wordsOf(s), r = w.length ? records.find(x => x.names.some(n => same(n, w))) : null;
    if (r) add(r); else if (String(s ?? '').trim()) rest.push(String(s));
  }
  for (const t of words) for (const r of records) if (r.names.some(n => n.length > 1 && holds(t, n))) add(r);
  return {records: [...out.values()], subjects: rest};
}

/** The host's records (recordOf's), its collections asked at most once per KEEP_MS; a collection that fails (signed out, warming,
 *  not this member's) adds none. */
export function recordsOf(host, now = Date.now()) {
  const had = kept.get(host);
  if (had && now - had.at < KEEP_MS) return had.records;
  const records = Promise.all(LISTS.map(op => host.call(op, {}).then(r => r?.results ?? [], () => [])))
    .then(lists => lists.flat().map(recordOf).filter(Boolean));
  kept.set(host, {at: now, records});
  return records;
}
