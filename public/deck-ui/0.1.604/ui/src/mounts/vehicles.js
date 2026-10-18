import {documentCollection} from './document-collection.js';
import {h} from '../../vendor/preact.mjs';
import {createVehicles} from '../vehicles.js';
import {Vehicles} from '../view/vehicles.js';

/** Vehicles: exact per-vehicle HA field ids in opts.mapping; papers/photos use the shared viewer. */
export function mountVehicles(el, host, opts = {}) {
  const vehicles = createVehicles(host, opts);
  const d = documentCollection(el, host, opts, 'Vehicles', onOpen => h(Vehicles, {model: vehicles, host, onOpen}));
  vehicles.subscribe(() => d.draw());
  vehicles.refresh();
  return {vehicles, refresh: () => vehicles.refresh(), unmount() { vehicles.stop(); d.unmount(); }};
}
