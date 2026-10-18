import {documentCollection} from './document-collection.js';
import {createTexts} from '../texts.js';
import {Texts} from '../view/texts.js';
import {h} from '../../vendor/preact.mjs';

/** Standalone read-only Texts list and shared conversation viewer. opts.onOpen(document) overrides the viewer.
 * Answers {texts, refresh(), unmount()}; refresh replaces the list, unmount cancels pending reads. */
export function mountTexts(el, host, opts = {}) {
  const texts = createTexts(host);
  const d = documentCollection(el, host, opts, 'Texts', (onOpen, navigation) => h(Texts, {model: texts, host, onOpen, navigation}));
  texts.subscribe(() => d.draw());
  texts.refresh();
  return {texts, refresh: () => texts.refresh(), unmount() { texts.stop(); d.unmount(); }};
}
