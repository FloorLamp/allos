import {createAttention} from '../attention.js';
import {Attention} from '../view/attention.js';
import {h, render} from '../../vendor/preact.mjs';
import {drawing} from '../mount-runtime.js';

/** Shared Attention; onCount(number) on changed snapshots, onCount(null) once on unmount. */
export function mountAttention(el, host, opts = {}) {
  const attention = createAttention(host, opts);
  const onOpen = opts.onOpen ?? (document => host.call('document.page', {id: document.id}));
  const d = drawing(el, 'Attention', () => render(h(Attention, {model: attention, host, onOpen}), el));
  attention.subscribe(() => d.draw());
  attention.refresh();
  return {attention, refresh: () => attention.refresh(), unmount() { attention.stop(); d.unmount(); }};
}
