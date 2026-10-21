import {sourceName} from '../../palette/model.mjs';
import {resourcePath} from './host/host.js';
// The owner's duplicate review (contract/people.md *Duplicate review*): bridge's `ask` pairs, the owner's decisions and undoing a
// merge. Bridge merges sure pairs by rule itself; only what it asks reaches here. No DOM.

// Cache only the authoritative snapshot, shared by the People page, Find and profiles. A failed read remains retryable.
const snapshots = new WeakMap(), listeners = new WeakMap(), owners = new WeakMap();
export const pairKey = pair => `${pair.a}\n${pair.b}`;

/** `listener({pair, choice})` after each decision any review on this host makes (`undo`: the pair is back for review). */
export function subscribeDuplicateDecisions(host, listener) {
  if (!listeners.has(host)) listeners.set(host, new Set());
  const subscribers = listeners.get(host);
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** Whether this is the owner's web session, the only one bridge takes identity decisions from: the web host's owner-session check
 *  (env.get's `caps.owner`), asked once per host. Members, the agent member and devices never review. */
export function ownerSession(host) {
  if (host?.kind !== 'web') return Promise.resolve(false);
  if (!owners.has(host)) {
    const pending = Promise.resolve().then(() => host.call('env.get', {})).then(env => !!(env?.caps ?? host.caps)?.owner, () => false);
    owners.set(host, pending);
  }
  return owners.get(host);
}

export function duplicatePairs(host, {refresh = false} = {}) {
  if (refresh) snapshots.delete(host);
  if (!snapshots.has(host)) {
    const pending = Promise.resolve().then(() => host.call('bridge.peopleDuplicates', {})).then(answer =>
      (answer.pairs ?? []).filter(pair => pair.verdict === 'ask' && pair.a !== pair.b && pair.people?.length === 2));
    snapshots.set(host, pending);
    pending.catch(() => { if (snapshots.get(host) === pending) snapshots.delete(host); });
  }
  return snapshots.get(host);
}

/** The pairs naming one person, by exact id: People's (each person's `view`) or the registry's (`a`, `b`); never a name or contact. */
export function pairsForPerson(pairs, id) {
  if (id == null) return pairs;
  const same = value => value != null && String(value) === String(id);
  return pairs.filter(pair => same(pair.a) || same(pair.b) || pair.people.some(person => same(person.view)));
}

/** Merge, Keep separate, or undo the owner's earlier decision on the pair (a merge split back, a Keep separate forgotten). */
export async function decidePair(host, pair, choice) {
  if (host.kind !== 'web' || !['merge', 'separate', 'undo'].includes(choice)) throw new Error('Use the owner web session to review this pair.');
  await (choice === 'undo' ? host.call('bridge.peopleDuplicateUndo', {a: pair.a, b: pair.b}) : host.call('bridge.peopleDuplicateDecision', {a: pair.a, b: pair.b, choice}));
  snapshots.delete(host);
  for (const listener of listeners.get(host) ?? []) listener({pair, choice});
}

/** Split a recorded merge (a profile's `merges[].id`) back out; bridge records Keep separate for the two. */
export async function unmerge(host, id) {
  if (host.kind !== 'web') throw new Error('Use the owner web session to undo a merge.');
  const answer = await host.call('bridge.peopleUnmerge', {id: String(id)});
  snapshots.delete(host);
  return answer;
}

/** A profile's undoable merges (bridge's `person.merges`): who joined, when, and how (by rule: its label, `same phone`). */
export const mergesOf = person => (Array.isArray(person?.merges) ? person.merges : [])
  .filter(m => m && m.id != null && ['rule', 'owner'].includes(m.by))
  .map(m => ({id: String(m.id), name: m.name || 'Unnamed person', at: m.at ?? null, by: m.by, label: m.by === 'rule' ? m.label || 'by rule' : null}));

/** How a merge came about, as the profile says it: `owner` whether the owner is the one reading. */
export const mergeHow = (merge, {owner = false} = {}) => merge.by === 'rule' ? `Merged automatically: ${merge.label}` : owner ? 'Merged by you' : 'Merged by the owner';

/** A person's sources as the palette names them (model.mjs `SOURCES`: chips and a person's From share one map). */
export const sourceWords = sources => [...new Set((sources ?? []).map(sourceName).filter(Boolean))];

/** A person's recorded portrait, only as bridge names it (`/v1/people/<view>/photo`, or the site's `/api/…` twin): else none. */
export function portraitOf(person) {
  const path = String(person?.photo ?? '').replace(/^\/api\//, '/v1/');
  return person?.view != null && path === `/v1/people/${encodeURIComponent(person.view)}/photo` && resourcePath(path, {shell: true}) ? path : null;
}

/** Why bridge asks, in words: the identifiers both hold, the same documents, a shared relation. */
export function evidenceWords(evidence = {}, {label}) {
  const ids = [...new Set(evidence.overlappingIdentifiers ?? [])].map(kind => `Same ${String(kind).toLowerCase()}`);
  return [...ids, evidence.identicalDocuments ? 'Same documents' : null, evidence.sharedRelation ? `Both ${label(evidence.sharedRelation).toLowerCase()}` : null]
    .filter(Boolean);
}

/** One person of a pair as facts for the side-by-side review, in the same order for both: sources, birth, papers and texts, last
 *  activity, then each contact as bridge sends it (already masked). `label`/`date`/`plural` the shared formatters. */
export function duplicateFacts(person, {date, plural}) {
  const counts = person.counts ?? {};
  return [
    {label: 'From', value: sourceWords(person.sources).join(', ') || 'Not recorded'},
    {label: 'Born', value: person.birth ? date(person.birth) : 'Not recorded'},
    {label: 'Has', value: `${plural(counts.papers ?? 0, 'paper')} · ${plural(counts.texts ?? 0, 'text')}`},
    {label: 'Last activity', value: person.lastActivity ? date(person.lastActivity) : 'None recorded'},
    ...(person.ids ?? []).filter(id => id?.value).map(id => ({label: id.title || 'Contact', value: String(id.value)})),
  ];
}
