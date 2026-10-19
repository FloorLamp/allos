import {h, render} from '../../vendor/preact.mjs';
import {createHouse} from '../house.js';
import {House} from '../view/house.js';
import {drawing} from '../mount-runtime.js';

/** The House page (contract/house.md *House*), offered only where the host's registry has a habitat backend (`host.backends`); else nothing
 *  is drawn. opts: `view` tablet | phone | admin, `brand`, `nav`, `current` (the shell bar, phone and admin), `quick` (entity ids),
 *  `rooms` ({area: name}), battery/temperature sensor readings (phone, grouped by device), `chart` (an entity charted hourly over 24 h; default the outdoor temperature, none on admin), `timeZone`,
 *  `clock`. Answers {house, update(opts), unmount()}; `house` is null when not offered. */
export function mountHouse(el, host, opts = {}) {
  if (!host.backends?.includes('habitat')) return {house: null, update() {}, unmount() {}};
  let o = opts;
  const view = o.view ?? 'tablet';
  const house = createHouse(host, {needsSource: o.needsSource, clock: o.clock, view, quick: o.quick, admin: view === 'admin', chart: view === 'admin' ? null : o.chart});
  const d = drawing(el, 'House', () => render(h(House, {house, host, opts: o}), el));
  house.subscribe(() => d.draw());
  house.start();
  return {house, update(next) { o = {...o, ...next}; house.watch(o); d.draw(); }, unmount() { house.stop(); d.unmount(); }};
}
