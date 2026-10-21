import {documentCollection} from './document-collection.js';
import {People} from '../view/people.js';
import {h} from '../../vendor/preact.mjs';

/** People without palette search chrome or literal search results. */
export function mountPeople(el, host, opts = {}) {
  const d = documentCollection(el, host, opts, 'People', (onOpen, navigation) => h(People, {host, onOpen, navigation}));
  return {unmount() { d.unmount(); }};
}
