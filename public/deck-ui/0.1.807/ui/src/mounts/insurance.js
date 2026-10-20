import {documentCollection} from './document-collection.js';
import {h} from '../../vendor/preact.mjs';
import {createInsurance} from '../insurance.js';
import {Insurance} from '../view/insurance.js';

export function mountInsurance(el, host, opts = {}) {
  const insurance = createInsurance(host, opts);
  const d = documentCollection(el, host, opts, 'Insurance', (onOpen, navigation) => h(Insurance, {model: insurance, host, onOpen, navigation}));
  insurance.subscribe(() => d.draw());
  insurance.refresh();
  return {insurance, refresh: () => insurance.refresh(), unmount() { insurance.stop(); d.unmount(); }};
}
