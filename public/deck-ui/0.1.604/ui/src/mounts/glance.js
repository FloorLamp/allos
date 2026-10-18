import {h, render} from '../../vendor/preact.mjs';
import {createGlance} from '../glance.js';
import {Glance} from '../view/glance.js';
import {drawing} from '../mount-runtime.js';

/** The menu bar's popover (glance.js). Answers {glance, unmount()}. */
export function mountGlance(el, host) {
  const glance = createGlance(host);
  let v = null;
  const d = drawing(el, 'Glance', () => v && render(h(Glance, {v, actions: glance}), el));
  const off = glance.subscribe(next => { v = next; d.draw(); });
  glance.load().catch(() => {});
  return {glance, unmount() { off(); glance.stop(); d.unmount(); }};
}
