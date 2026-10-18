import {h, render} from '../../vendor/preact.mjs';
import {Drawer} from '../view/drawer.js';
import {drawing} from '../mount-runtime.js';

/** The detail drawer (contract/foundation.md *Drawer*): opts {open, title, sub, onClose, children, label}; children is text or a Preact node.
 *  Answers {update(opts), unmount()}. */
export function mountDrawer(el, opts = {}) {
  let o = opts;
  const d = drawing(el, 'Drawer', () => render(h(Drawer, o), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}
