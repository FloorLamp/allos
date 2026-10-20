import {h} from '../../vendor/preact.mjs';
import {useRef} from '../../vendor/hooks.mjs';
import {collectionTarget, collectionName} from '../collection-target.js';
import {CollectionEntityContent} from './viewer/collection.js';
import {Drawer} from './drawer.js';

/** Drawer framing only: entity loading, actions and content are shared with pages and viewers. */
export function CollectionDetails({host, item, onClose, onOpen}) {
  const states = useRef(new Map()), target = collectionTarget(item), key = target ? `${target.collection}:${target.id}` : '';
  if (target && !states.current.has(key)) states.current.set(key, {});
  return h(Drawer, {open: !!target, title: item?.title ?? collectionName(target), onClose}, target ?
    h(CollectionEntityContent, {host, target, view: states.current.get(key), onClose, onOpen}) : null);
}
