import {createSecurity} from '../security.js';
import {Security} from '../view/security.js';
import {h, render} from '../../vendor/preact.mjs';
import {drawing} from '../mount-runtime.js';

/** Read-only Security foundation; sources are protected HTTP adapters (SECURITY.md). */
export function mountSecurity(el, sources = {}) {
  const security = createSecurity(sources);
  const d = drawing(el, 'Security', () => render(h(Security, {security}), el));
  security.subscribe(() => d.draw());
  security.refresh();
  return {security, refresh: () => security.refresh(), unmount() { security.stop(); d.unmount(); }};
}
