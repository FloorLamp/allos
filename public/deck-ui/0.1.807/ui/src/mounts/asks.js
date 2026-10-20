import {h, render} from '../../vendor/preact.mjs';
import {Asks} from '../view/sections/asks.js';
import {useFold} from '../view/sections/fold.js';
import {drawing} from '../mount-runtime.js';

/** Asked lately on Find's landing (view/sections/asks.js): opts `asks` (bridge's `/api/asks` list), `onAsk(question)`, `limit` (5).
 *  Answers {update(opts), unmount()}. */
export function mountAsks(el, host, opts = {}) {
  let o = opts;
  const Folded = props => h(Asks, {...props, fold: useFold(host)});
  const d = drawing(el, 'Asks', () => render(h('div', {class: 'dp'}, h(Folded, o)), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}
