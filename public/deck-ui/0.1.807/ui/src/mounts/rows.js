import {CollectionDetails} from '../view/collection-details.js';
import {h, render} from '../../vendor/preact.mjs';
import {RowList} from '../view/rows.js';
import {drawing} from '../mount-runtime.js';

/** Plain rows on bridge's own pages (clusters, attention, the map's lists): documents, clusters and lines in the rows'
 *  anatomy (view/rows.js RowList). opts: `items`, `current`, `checkable`, `checked`, `onCheck`, `onOpen(item, {page})` (default: the
 *  item's `href`, else a document's page, a cluster's; Mod+click a new tab; until `items` comes, loading), `onSource(item)` (default: the document's page at its
 *  source through the host), `loading`, `error`, `empty`, `sectionTotal(items, section)`, `search` (default true: the shared search past one page or 20 rows; false where the page has its own search, a string labels
 *  the filter). Answers {update(opts), unmount()}. */
export function mountRows(el, host, opts = {}) {
  let o = opts, selected = null;
  const href = it => it.href ?? (it.document ? `/doc/${it.document.id}` : it.cluster ? `/clusters#${it.cluster.id}` : null);
  const open = (it, {page}) => {
    const to = href(it);
    if (!to) return;
    if (page) window.open(to, '_blank', 'noopener'); else location.assign(to);
  };
  const source = it => host.call('document.page', {id: it.document.id, url: it.document.url ?? null}).catch(() => {});
  const d = drawing(el, 'Rows', () => render(h('div', {},
    h(RowList, {host, search: true, ...o, items: o.items?.map(it => it.cluster ? {...it, end: {label: 'Details ›', onClick: () => { selected = it; d.draw(); }}} : it), onOpen: o.onOpen ?? open, onSource: o.onSource ?? source}),
    h(CollectionDetails, {host, item: selected, onClose: () => { selected = null; d.draw(); }, onOpen: document => (o.onOpen ?? open)({document}, {page: false})})), el));
  return {update(next) { o = {...o, ...next}; d.draw(); }, unmount() { d.unmount(); }};
}
