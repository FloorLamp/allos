import {h, render} from '../../vendor/preact.mjs';
import {StatTiles} from '../view/stat-tiles.js';
import {drawing} from '../mount-runtime.js';

/** Stat tiles (contract/foundation.md *Stat tiles*): opts {tiles, onOpen(ref), label}. Answers {update(opts), unmount()}. */
export function mountStatTiles(el, opts = {}) {
  let o = opts;
  const d = drawing(el, 'StatTiles', () => render(h(StatTiles, o), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}
