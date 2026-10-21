import {HostError} from './host/host.js';
import {physicalThingId} from './collection-target.js';
import {maskIdentifiers} from './identifiers.js';
import {paperProjection, policyProjection} from './collection-projections.js';

const field = {people: 'person', vehicles: 'vehicle', properties: 'property', insurance: 'insurance', papers: 'paper', things: 'thing'};

export function normalizeCollectionAnswer(answer) {
  if (!answer || typeof answer !== 'object') return answer;
  return {...answer,
    ...(answer.insurance ? {insurance: policyProjection(answer.insurance)} : {}),
    ...(answer.paper ? {paper: paperProjection(answer.paper)} : {}),
    ...(answer.packet ? {packet: maskIdentifiers(answer.packet)} : {})};
}

// A record is read once for its card and its full view, whichever comes first (Find's selected record, then Enter; a full view
// opened before its card has drawn): a card's read is kept for a minute and taken once by the next full view; a full view's read is
// kept for its card only (a full view always reads afresh after its own); a read still on its way is joined; a failure is never kept.
// The page leaving (a record opening on its collection's page) refuses a card's read still waiting on its pause: the host's
// (host/page-life.js), as every read.
const KEEP_MS = 60_000, kept = new WeakMap(), pending = new WeakMap();
// A deferred card may start after navigation begins. Keep the page's aborted signal for those late reads too.
let pageLifetime = new AbortController();
globalThis.addEventListener?.('beforeunload', () => pageLifetime.abort());
globalThis.addEventListener?.('pageshow', () => { if (pageLifetime.signal.aborted) pageLifetime = new AbortController(); });
const mapOf = (maps, host) => { let m = maps.get(host); if (!m) maps.set(host, m = new Map()); return m; };
/** Load a recorded entity target. Virtual documents use their published pages, never a guessed document ID. `keep`: a card's read
 *  (see above). */
export function collectionAnswer(host, target, {signal, document = target.document, keep = false} = {}) {
  const key = `${target.collection}:${target.id}`, mine = mapOf(kept, host), going = mapOf(pending, host), now = Date.now();
  const hit = mine.get(key), fresh = hit && now - hit.at < KEEP_MS;
  if (hit && !fresh) mine.delete(key);
  if (fresh && keep) return abortable(hit.answer, signal);
  if (fresh && !hit.cards) { mine.delete(key); return abortable(hit.answer, signal); }
  if (going.has(key)) return abortable(going.get(key), signal);
  // a card's read is shared: its reader leaving stops waiting for it, never cancels it; another's is its own to cancel
  // Shared reads outlive their card, but never their page. Abort before WebKit tears down its transport.
  const signalForRead = !keep && signal ? AbortSignal.any([signal, pageLifetime.signal]) : pageLifetime.signal;
  const answer = readCollection(host, target, {document, signal: signalForRead});
  going.set(key, answer);
  const done = () => { if (going.get(key) === answer) going.delete(key); };
  answer.then(done, done);
  const entry = {at: now, answer, cards: !keep};
  mine.set(key, entry);
  answer.catch(() => { if (mine.get(key) === entry) mine.delete(key); });
  return keep ? abortable(answer, signal) : answer;
}
const abortable = (promise, signal) => !signal ? promise : new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason);
  const done = () => signal.removeEventListener('abort', abort);
  // Attach even when already aborted: the shared read may still reject after its reader leaves.
  promise.then(value => { done(); resolve(value); }, error => { done(); reject(error); });
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, {once: true});
});

async function readCollection(host, target, {document, signal}) {
  const options = {signal}, call = (op, args) => host.call(op, args, options);
  if (target.collection === 'clusters') return {kind: 'collection', collection: 'clusters', ...await call('bridge.cluster', {id: target.id})};
  if (target.collection === 'taxes') return {kind: 'collection', collection: 'taxes', packet: maskIdentifiers(await call('bridge.taxPacket', {year: Number(target.id)}))};
  if (target.collection === 'papers') {
    const answer = await call('bridge.papers', {}), row = answer?.results?.find(row => String(row.paper?.id) === target.id);
    if (!row) throw new HostError('http', 'Identity paper unavailable', 404);
    return {kind: 'collection', collection: 'papers', paper: paperProjection(row.paper, row.state)};
  }
  if (Number.isSafeInteger(document?.id) && document.id > 0) return call('bridge.pages', {id: document.id});
  // a thing by its id: a physical thing's page (its hub) is bridge's thing detail, read once here for its name and handed to its view
  // (`detail`); a product is bridge's thing read
  if (target.collection === 'things') {
    if (!physicalThingId(target.id)) return {kind: 'collection', collection: 'things', thing: await call('bridge.thing', {id: target.id})};
    const detail = (await call('bridge.things.detail', {query: {id: target.id}}))?.thing;
    const same = String(detail?.id ?? '').toLowerCase() === target.id.toLowerCase();
    return {kind: 'collection', collection: 'things', thing: {id: target.id, thingId: target.id, type: 'product', name: same ? detail.name : null, detail: same ? detail : null}};
  }
  const answer = await call(`bridge.${target.collection}`, {}), key = field[target.collection];
  const row = answer?.results?.find(row => String(row[key]?.id) === target.id);
  if (!row) throw new HostError('http', 'Collection item unavailable', 404);
  const id = row.document?.id ?? row[key]?.view;
  // a record with no published view: its collection's own projection is the record (a full view opened from its page)
  if (!Number.isSafeInteger(id) || id <= 0) return {kind: 'collection', collection: target.collection, [key]: row[key]};
  return call('bridge.pages', {id});
}

