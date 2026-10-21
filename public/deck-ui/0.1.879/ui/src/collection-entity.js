import {collectionTarget} from './collection-target.js';
import {createVehicles} from './vehicles.js';
import {createProperties} from './properties.js';
import {createClusters} from './clusters.js';

/** Reuse page models for optional reads/actions, seeded with the pages answer already in memory. */
export function createCollectionEntity(host, answer, {mapping = null} = {}) {
  const target = collectionTarget(answer);
  if (target?.collection === 'vehicles') {
    const model = createVehicles(host, {mapping}), refresh = model.refresh.bind(model);
    model.refresh = () => refresh({vehicle: answer.vehicle});
    return {target, model, start: () => model.refresh()};
  }
  if (target?.collection === 'properties') {
    const model = createProperties(host), refresh = model.refresh.bind(model);
    model.refresh = () => refresh({property: answer.property});
    return {target, model, start: () => model.refresh()};
  }
  if (target?.collection === 'clusters') {
    const model = createClusters(host);
    model.adopt(answer);
    return {target, model, start: () => host.caps.clusters ? model.refresh() : Promise.resolve()};
  }
  return {target, model: null, start: () => Promise.resolve()};
}
