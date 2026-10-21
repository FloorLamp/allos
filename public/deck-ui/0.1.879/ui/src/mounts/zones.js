import {h, render} from '../../vendor/preact.mjs';
import {createZones} from '../zones.js';
import {Zones} from '../view/zones.js';
import {drawing} from '../mount-runtime.js';

/** The zone editor (contract/house.md *Zones*), offered only where the host's registry has a habitat backend. opts: `canWrite` (false:
 *  the list and the map alone, as the agent member reads them). Answers {zones, ready, unmount()}. */
export function mountZones(el, host, opts = {}) {
  const zones = createZones(host, {canWrite: opts.canWrite !== false});
  const d = drawing(el, 'Zones', () => render(h(Zones, {model: zones, host}), el));
  zones.subscribe(() => d.draw());
  const ready = zones.start();
  return {zones, ready, unmount() { zones.stop(); d.unmount(); }};
}
