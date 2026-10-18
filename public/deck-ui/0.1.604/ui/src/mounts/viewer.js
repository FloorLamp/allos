import {h, render} from '../../vendor/preact.mjs';
import {createViewer} from '../viewer.js';
import {Viewer} from '../view/viewer/frame.js';
import {drawing} from '../mount-runtime.js';

/** The document viewer: opts {id, query, document}, {collection: {collection, id, document?}}, or {recent}; `embedded` (default on the site): no close, a kind it cannot show
 *  stays as a state; `onClose`, `onGroup(key, title)` (none: a Related chip opens the map, `All n ›` every item in the rail);
 *  `details` (false: no Details pane; the page mounts its own, mountDetails). Answers {viewer, open(target), unmount()}. */
export function mountViewer(el, host, opts = {}) {
  const v = createViewer(host, {embedded: opts.embedded ?? host.kind === 'web', onClose: opts.onClose, onGroup: opts.onGroup, details: opts.details ?? true});
  let env = {mod: 'Control'};
  const d = drawing(el, 'Viewer', () => render(h(Viewer, {v, env}), el));
  host.call('env.get', {}).then(r => { if (r) { env = r; d.draw(); } }, () => {});
  v.start();
  if (opts.collection != null || opts.health != null || opts.id != null || opts.recent != null) v.open(opts);
  return {viewer: v, open: target => v.open(target), unmount() { v.reset(); d.unmount(); }};
}
