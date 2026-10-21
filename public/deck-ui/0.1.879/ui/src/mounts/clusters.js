import {documentCollection} from './document-collection.js';
import {createClusters} from '../clusters.js';
import {Clusters} from '../view/clusters.js';
import {h} from '../../vendor/preact.mjs';
import {recordHref} from '../collection-target.js';

/** Document undertakings (Clusters). opts.onOpen overrides the shared viewer. */
export function mountClusters(el, host, opts = {}) {
  const clusters = createClusters(host);
  // a document's page, the cluster's own or a record's it names (`/clusters?record=<id>#<id>`: contract/collections.md)
  const pageOf = ({cluster, document, record}) => document ? `/doc/${document.id}` : recordHref(record ?? {collection: 'clusters', id: cluster});
  const onPage = target => {
    const origin = /^https?:$/.test(el.ownerDocument.location?.protocol) ? el.ownerDocument.location.origin : 'https://deck.wang.team';
    return host.call('url.open', {url: new URL(pageOf(target), origin).href}).catch(() => {});
  };
  const onRecord = record => el.ownerDocument.defaultView?.location.assign(pageOf({record}));
  const d = documentCollection(el, host, opts, 'Clusters', (onOpen, navigation) => h(Clusters, {model: clusters, host, onOpen, onRecord, onPage, navigation}));
  const select = clusters.select.bind(clusters);
  clusters.select = async id => {
    if (d.navigation.hash !== (id ?? '')) d.navigation.selectHash(id ?? '');
    await select(id);
    if (d.navigation.hash === (id ?? '') && clusters.detail?.cluster.id === clusters.id && clusters.id !== id) d.navigation.selectHash(clusters.id);
  };
  clusters.subscribe(() => d.draw());
  clusters.refresh().then(() => { if (opts.id && !d.navigation.hash) d.navigation.selectHash(opts.id); });
  return {clusters, refresh: () => clusters.refresh(), unmount() { clusters.stop(); d.unmount(); }};
}
