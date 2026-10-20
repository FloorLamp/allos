import {h, render} from '../../vendor/preact.mjs';
import {NavTiles} from '../view/shell-bar.js';
import {drawing} from '../mount-runtime.js';

/** Phone navigation, mounted by the host immediately below its Find box. */
export function mountNavTiles(el, opts = {}) {
  let o = {...opts};
  const d = drawing(el, 'NavTiles', () => render(h(NavTiles, o), el));
  return {update(patch) { o = {...o, ...patch}; d.draw(); }, unmount() { d.unmount(); }};
}
