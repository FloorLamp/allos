import {documentCollection} from './document-collection.js';
import {h} from '../../vendor/preact.mjs';
import {createPapers} from '../papers.js';
import {Papers} from '../view/papers.js';

export function mountPapers(el, host, opts = {}) {
  const papers = createPapers(host, opts);
  const d = documentCollection(el, host, opts, 'Papers', (onOpen, navigation) => h(Papers, {model: papers, host, onOpen, navigation}));
  papers.subscribe(() => d.draw());
  papers.refresh();
  return {papers, refresh: () => papers.refresh(), unmount() { papers.stop(); d.unmount(); }};
}
