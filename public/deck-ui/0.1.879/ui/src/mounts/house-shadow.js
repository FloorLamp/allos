import {h, render} from '../../vendor/preact.mjs';
import {createShadow} from '../house-shadow.js';
import {HouseShadow} from '../view/house-shadow.js';
import {drawing} from '../mount-runtime.js';

/** Habitat's shadow reports (contract/house.md *Admin pages*). opts: `query` ({rule, days}), `canSwitch` (the owner's cut over and
 *  roll back), `links` (the header's). Answers {shadow, ready, unmount()}. */
export function mountHouseShadow(el, host, opts = {}) {
  const shadow = createShadow(host, {query: opts.query, canSwitch: !!opts.canSwitch, clock: opts.clock});
  const d = drawing(el, 'HouseShadow', () => render(h(HouseShadow, {model: shadow, host, links: opts.links}), el));
  shadow.subscribe(() => d.draw());
  const ready = shadow.start();
  return {shadow, ready, unmount() { shadow.stop(); d.unmount(); }};
}
