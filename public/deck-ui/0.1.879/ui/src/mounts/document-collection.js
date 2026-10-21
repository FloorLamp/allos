import {h, render, Fragment} from '../../vendor/preact.mjs';
import {createViewer, textsOf} from '../viewer.js';
import {Viewer} from '../view/viewer/frame.js';
import {pageNavigation, documentId} from '../page-navigation.js';
import {drawing} from '../mount-runtime.js';
import {COLLECTIONS} from '../collection-target.js';

/** Keep the mounted list (including filters and opened rows) alive beneath its document viewer. `split` (Texts): the page lays the
 *  viewer out beside its list itself, `paint(onOpen, navigation, {viewer, open})` given the viewer while one is open and the open id.
 *  A collection's page (`mount` names one: Vehicles, People, …) also shows a record's full view in the same viewer
 *  (`navigation.openRecord(id)`, `?record=<id>`: contract/collections.md). */
export function documentCollection(el, host, opts, mount, paint, {split = false} = {}) {
  let viewing = false, target = null, open = null, record = null, recordTitle = null;
  const collection = COLLECTIONS.includes(mount.toLowerCase()) ? mount.toLowerCase() : null;
  const viewerId = id => documentId(id) ?? (textsOf(id) ? id : null);
  const viewer = createViewer(host, {embedded: false, onClose: () => navigation.close()});
  const show = () => {
    viewing = open != null || record != null;
    if (open != null) viewer.open(target?.id === open ? {id: open, document: target} : {id: open});
    else if (record != null) viewer.open({collection: {collection, id: record}, ...(recordTitle ? {title: recordTitle} : {})});
    else viewer.reset();
    d.draw();
    if (!viewing) navigation.restoreScroll();
  };
  const navigation = pageNavigation(el.ownerDocument, id => { open = id; show(); },
    {parseDocument: viewerId, onRecord: collection ? (id, title) => { record = id; recordTitle = title; show(); } : null});
  const onOpen = opts.onOpen ?? (document => { if (!viewerId(document?.id)) return; target = document; navigation.open(document.id); });
  const d = drawing(el, mount, () => render(split ? paint(onOpen, navigation, {open, viewer: viewing ? h(Viewer, {key: 'viewer', v: viewer, env: {mod: 'Control'}}) : null}) : h(Fragment, {},
    h('div', {key: 'list', hidden: viewing, inert: viewing ? '' : undefined}, paint(onOpen, navigation)),
    viewing ? h(Viewer, {key: 'viewer', v: viewer, env: {mod: 'Control'}}) : null), el));
  viewer.subscribe(() => d.draw());
  navigation.start();
  return {navigation, draw: () => d.draw(), unmount() { navigation.stop(); viewer.reset(); d.unmount(); }};
}
