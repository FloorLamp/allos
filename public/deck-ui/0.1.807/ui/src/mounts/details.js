import {h, render} from '../../vendor/preact.mjs';
import {createDetails} from '../details.js';
import {Details} from '../view/viewer/details.js';
import {drawing} from '../mount-runtime.js';

/** The Details pane on its own (the site's document page, beside its viewer): what was read from document `id` and, with the
 *  host's `corrections` cap, the owner's corrections. opts: `document` (bridge.doc's answer the page has already: not asked again),
 *  `onChange(doc)` after each write (the page's head). Answers {details, ready (its sheets in), follow(viewer), unmount()}: `follow` the page's viewer, so a record
 *  it shows (record.js) leaves the pane only what the record does not. */
export function mountDetails(el, host, opts = {}) {
  const d = createDetails(host, {onChange: opts.onChange});
  let env = {mod: 'Control'};
  const p = drawing(el, 'Details', () => render(h(Details, {d, mod: env.mod}), el));
  host.call('env.get', {}).then(r => { if (r) { env = r; p.draw(); } }, () => {});
  if (opts.document) d.show(opts.document); else d.load(opts.id);
  let off = null;
  const follow = v => {
    off?.();
    const sync = () => d.setRecord(v.entry && v.entry.id === d.id ? v.entry.answer?.record ?? null : null);
    off = v.subscribe(sync);
    sync();
  };
  return {details: d, ready: p.styled, follow, unmount: () => { off?.(); p.unmount(); }};
}
