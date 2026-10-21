import {h, render} from '../../vendor/preact.mjs';
import {createZigbee} from '../house-zigbee.js';
import {HouseZigbee} from '../view/house-zigbee.js';
import {drawing} from '../mount-runtime.js';

/** Zigbee reconnect (contract/house.md *Admin pages*). opts: `transport` (the host's: read, permit, stream), `owner` (the join
 *  controls), `links` (the header's). Answers {zigbee, ready, unmount()}. */
export function mountHouseZigbee(el, host, opts = {}) {
  const zigbee = createZigbee(opts.transport, {owner: !!opts.owner, clock: opts.clock});
  const d = drawing(el, 'HouseZigbee', () => render(h(HouseZigbee, {model: zigbee, host, links: opts.links}), el));
  zigbee.subscribe(() => d.draw());
  const ready = zigbee.start();
  return {zigbee, ready, unmount() { zigbee.stop(); d.unmount(); }};
}
