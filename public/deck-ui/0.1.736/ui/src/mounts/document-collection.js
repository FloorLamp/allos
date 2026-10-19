import {h, render, Fragment} from '../../vendor/preact.mjs';
import {createViewer, textsOf} from '../viewer.js';
import {Viewer} from '../view/viewer/frame.js';
import {pageNavigation, documentId} from '../page-navigation.js';
import {drawing} from '../mount-runtime.js';

/** Keep the mounted list (including filters and drawers) alive beneath its document viewer. */
export function documentCollection(el, host, opts, mount, paint) {
  let viewing = false, target = null;
  const viewerId = id => documentId(id) ?? (textsOf(id) ? id : null);
  const viewer = createViewer(host, {embedded: false, onClose: () => navigation.close()});
  const navigation = pageNavigation(el.ownerDocument, id => {
    viewing = id != null;
    if (viewing) viewer.open(target?.id === id ? {id, document: target} : {id});
    else viewer.reset();
    d.draw();
    if (!viewing) navigation.restoreScroll();
  }, {parseDocument: viewerId});
  const onOpen = opts.onOpen ?? (document => { if (!viewerId(document?.id)) return; target = document; navigation.open(document.id); });
  const d = drawing(el, mount, () => render(h(Fragment, {},
    h('div', {key: 'list', hidden: viewing, inert: viewing ? '' : undefined}, paint(onOpen, navigation)),
    viewing ? h(Viewer, {key: 'viewer', v: viewer, env: {mod: 'Control'}}) : null), el));
  viewer.subscribe(() => d.draw());
  navigation.start();
  return {navigation, draw: () => d.draw(), unmount() { navigation.stop(); viewer.reset(); d.unmount(); }};
}
