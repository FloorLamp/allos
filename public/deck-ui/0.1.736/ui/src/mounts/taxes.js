import {documentCollection} from './document-collection.js';
import {h} from '../../vendor/preact.mjs';
import {createTaxes} from '../taxes.js';
import {Taxes} from '../view/taxes.js';

export function mountTaxes(el, host, opts = {}) {
  const taxes = createTaxes(host, opts);
  const d = documentCollection(el, host, opts, 'Taxes', (onOpen, navigation) => h(Taxes, {model: taxes, host, onOpen, navigation}));
  taxes.subscribe(() => d.draw());
  taxes.refresh();
  return {taxes, refresh: () => taxes.refresh(), unmount() { taxes.stop(); d.unmount(); }};
}
