import {h, render} from '../../vendor/preact.mjs';
import {createViewer} from '../viewer.js';
import {Viewer} from '../view/viewer/frame.js';
import {drawing} from '../mount-runtime.js';

/** The document viewer: opts {id, query, document}, {collection: {collection, id, document?}}, or {recent}; `embedded` (default on the site): no close, a kind it cannot show
 *  stays as a state; `onClose`, `onGroup(key, title)` (none: a day's or a subject's chip opens the map); `details` (false: no Details
 *  section); `slowMs`, `timeoutMs` (viewer.js: when a wait reads as slow, then fails). Answers {viewer, ready (its sheets in),
 *  open(target), unmount()}. */
export function mountViewer(el, host, opts = {}) {
  const v = createViewer(host, {embedded: opts.embedded ?? host.kind === 'web', onClose: opts.onClose, onGroup: opts.onGroup, details: opts.details ?? true,
    ...(opts.slowMs ? {slowMs: opts.slowMs} : {}), ...(opts.timeoutMs ? {timeoutMs: opts.timeoutMs} : {})});
  let env = {mod: 'Control'};
  const d = drawing(el, 'Viewer', () => render(h(Viewer, {v, env}), el));
  host.call('env.get', {}).then(r => { if (r) { env = r; d.draw(); } }, () => {});
  if (opts.collection != null || opts.health != null || opts.id != null || opts.recent != null) v.open(opts);
  return {viewer: v, ready: d.styled, open: target => v.open(target), unmount() { v.reset(); d.unmount(); }};
}
