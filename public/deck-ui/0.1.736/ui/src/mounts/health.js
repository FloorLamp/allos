import {h, render} from '../../vendor/preact.mjs';
import {createViewer} from '../viewer.js';
import {Viewer} from '../view/viewer/frame.js';
import {createHealth} from '../health.js';
import {Health} from '../view/health.js';
import {drawing} from '../mount-runtime.js';

/** Health is hidden until allos.me verifies the owner; errors clear it. opts.onRecord overrides the shared viewer. */
export function mountHealth(el, host, opts = {}) {
  const health = createHealth(host);
  let viewer = null;
  const v = createViewer(host, {onClose: () => { viewer = null; v.reset(); d.draw(); }});
  const onRecord = opts.onRecord ?? (target => { viewer = v; v.open({health: target, title: target.title}); d.draw(); });
  const d = drawing(el, 'Health', () => render(viewer ? h(Viewer, {v, env: {mod: 'Control'}}) : h(Health, {health, host, opts: {...opts, onRecord}}), el));
  health.subscribe(() => { if (!health.owner) { viewer = null; v.reset(); } d.draw(); });
  v.subscribe(() => d.draw());
  health.start();
  return {health, refresh: () => health.refresh(), unmount() { health.stop(); v.reset(); d.unmount(); }};
}
