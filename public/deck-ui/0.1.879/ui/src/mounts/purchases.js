import {h} from '../../vendor/preact.mjs';
import {documentCollection} from './document-collection.js';
import {Purchases} from '../view/purchases.js';

export function mountPurchases(el, host, opts = {}) {
  const d = documentCollection(el, host, opts, 'Purchases', onOpen => h(Purchases, {host, onOpen}));
  return {unmount() { d.unmount(); }};
}
