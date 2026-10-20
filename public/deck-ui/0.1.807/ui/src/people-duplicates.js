import {SOURCES} from '../../palette/model.mjs';
// Cache only the authoritative snapshot, shared by search and profiles. A failed read remains retryable.
const snapshots = new WeakMap(), listeners = new WeakMap();
export function subscribeDuplicateDecisions(host, listener) {
  if (!listeners.has(host)) listeners.set(host, new Set());
  const subscribers = listeners.get(host);
  subscribers.add(listener);
  return () => subscribers.delete(listener);
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

export function pairsForPerson(pairs, id) {
  return id == null ? pairs : pairs.filter(pair => [pair.a, pair.b].some(value => String(value) === String(id)));
}

export async function decidePair(host, pair, choice) {
  if (host.kind !== 'web' || !['merge', 'separate'].includes(choice)) throw new Error('Use the owner web session to review this pair.');
  await host.call('bridge.peopleDuplicateDecision', {a: pair.a, b: pair.b, choice});
  snapshots.delete(host);
  for (const listener of listeners.get(host) ?? []) listener(pair);
}

const IDENTIFIERS = {phone: 'Phone', email: 'Email', tel: 'Phone', mobile: 'Mobile', handle: 'Handle'};
/** One person of a pair as facts for the side-by-side review: relation, sources, birth and each contact identifier, in words
 *  (`phone:5550100` → Phone 5550100). `label`/`date` the shared formatters (fieldLabel, dateText). */
export function duplicateFacts(person, {label, date}) {
  const ids = (person.identifiers ?? []).map(id => {
    const [kind, ...rest] = String(id).split(':');
    return rest.length ? {label: IDENTIFIERS[kind.toLowerCase()] ?? label(kind), value: rest.join(':')} : {label: 'Contact', value: String(id)};
  });
  return [
    {label: 'Relation', value: person.relation ? label(person.relation) : 'Not recorded'},
    {label: 'From', value: (person.sources ?? []).map(s => SOURCES[String(s).toLowerCase()] ?? label(s)).join(', ') || 'Not recorded'},
    ...(person.birth ? [{label: 'Born', value: date(person.birth)}] : []),
    ...ids,
  ];
}
