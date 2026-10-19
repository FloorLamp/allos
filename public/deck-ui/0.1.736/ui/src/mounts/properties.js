import {documentCollection} from './document-collection.js';
import {h} from '../../vendor/preact.mjs';
import {createProperties} from '../properties.js';
import {Properties} from '../view/properties.js';

/** Properties and their indexed papers, using the shared document viewer. */
export function mountProperties(el, host, opts = {}) {
  const properties = createProperties(host, opts);
  const d = documentCollection(el, host, opts, 'Properties', (onOpen, navigation) => h(Properties, {model: properties, host, onOpen, navigation}));
  properties.subscribe(() => d.draw());
  properties.refresh();
  return {properties, refresh: () => properties.refresh(), unmount() { properties.stop(); d.unmount(); }};
}
