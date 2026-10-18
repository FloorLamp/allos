import {documentCollection} from './document-collection.js';
import {createClusters} from '../clusters.js';
import {Clusters} from '../view/clusters.js';
import {h} from '../../vendor/preact.mjs';

/** Document undertakings (Clusters). opts.onOpen overrides the shared viewer. */
export function mountClusters(el, host, opts = {}) {
  const clusters = createClusters(host);
  const onPage = ({cluster, document}) => {
    const origin = /^https?:$/.test(el.ownerDocument.location?.protocol) ? el.ownerDocument.location.origin : 'https://deck.wang.team';
    const url = new URL(document ? `/doc/${document.id}` : '/clusters', origin);
    if (cluster) url.hash = cluster;
    return host.call('url.open', {url: url.href}).catch(() => {});
  };
  const d = documentCollection(el, host, opts, 'Clusters', (onOpen, navigation) => h(Clusters, {model: clusters, host, onOpen, onPage, navigation}));
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
