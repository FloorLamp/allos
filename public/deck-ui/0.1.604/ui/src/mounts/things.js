import {documentCollection} from './document-collection.js';
import {h} from '../../vendor/preact.mjs';
import {createThings} from '../things.js';
import {Things} from '../view/things.js';

export function mountThings(el, host, opts = {}) {
  const things = createThings(host, opts);
  const d = documentCollection(el, host, opts, 'Things', (onOpen, navigation) => h(Things, {model: things, host, onOpen, navigation}));
  things.subscribe(() => d.draw());
  things.refresh();
  return {things, refresh: () => things.refresh(), unmount() { things.stop(); d.unmount(); }};
}
