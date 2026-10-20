import {HostError} from './host/host.js';
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

/** Load a recorded entity target. Virtual documents use their published pages, never a guessed document ID. */
export async function collectionAnswer(host, target, {signal, document = target.document} = {}) {
  const options = {signal}, call = (op, args) => host.call(op, args, options);
  if (target.collection === 'clusters') return {kind: 'collection', collection: 'clusters', ...await call('bridge.cluster', {id: target.id})};
  if (target.collection === 'taxes') return {kind: 'collection', collection: 'taxes', packet: maskIdentifiers(await call('bridge.taxPacket', {year: Number(target.id)}))};
  if (target.collection === 'papers') {
    const answer = await call('bridge.papers', {}), row = answer?.results?.find(row => String(row.paper?.id) === target.id);
    if (!row) throw new HostError('http', 'Identity paper unavailable', 404);
    return {kind: 'collection', collection: 'papers', paper: paperProjection(row.paper, row.state)};
  }
  if (Number.isSafeInteger(document?.id) && document.id > 0) return call('bridge.pages', {id: document.id});
  const answer = await call(`bridge.${target.collection}`, {}), key = field[target.collection];
  const row = answer?.results?.find(row => String(row[key]?.id) === target.id);
  if (!row) throw new HostError('http', 'Collection item unavailable', 404);
  const id = row.document?.id ?? row[key]?.view;
  if (!Number.isSafeInteger(id) || id <= 0) throw new HostError('http', 'Collection document unavailable', 404);
  return call('bridge.pages', {id});
}

