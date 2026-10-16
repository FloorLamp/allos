import {openMap} from './map.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {collectionDetails} from '../collection-details.js';
import {Drawer, Facts} from './drawer.js';
import {RowList} from './rows.js';
import {StatTiles} from './stat-tiles.js';
import {Failure} from './failure.js';
const html = htm.bind(h);

export function CollectionDetails({host, item, onClose, onOpen}) {
  const [state, setState] = useState({}), [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setState({});
    if (item) collectionDetails(host, item, request.signal).then(data => {
      if (!request.signal.aborted) setState(data);
    }, error => { if (!request.signal.aborted) setState({error}); });
    return () => request.abort();
  }, [item, host, retry]);
  const entity = state.entity ?? item?.person ?? item?.project ?? {}, papers = state.papers ?? [];
  return html`<${Drawer} open=${!!item} title=${entity.name ?? item?.title ?? 'Details'} onClose=${onClose}>
    ${item ? html`<button class="dk-btn" onClick=${() => openMap(host, {by: item.person ? 'subject' : 'project', value: String(item.person ? entity.name ?? item.title : entity.id ?? item.project.id), label: entity.name ?? item.title})}>Map</button>` : null}
    ${state.error ? html`<${Failure} backend="bridge" error=${state.error} host=${host} retry=${() => setRetry(n => n + 1)} />` : !state.entity ? html`<p role="status">Loading details…</p>` : html`
      <${Facts} facts=${(item?.person ? ['relation', 'role', 'organisation', 'vendor', 'lastContact'] : ['kind', 'state', 'from', 'to', 'summary']).map(key => ({label: key === 'lastContact' ? 'Last contact' : key[0].toUpperCase() + key.slice(1), value: entity[key]}))} />
      ${entity.ids?.length ? html`<${Facts} facts=${entity.ids.map(x => ({label: x.title, value: x.value}))} />` : null}
      <${StatTiles} label="Collection documents" tiles=${[{key: 'documents', label: 'Indexed documents', quantity: {value: papers.length}}, {key: 'renewals', label: 'Recorded renewals', quantity: {value: papers.filter(p => p.renewal).length}}]} />
      <h2>Documents</h2>
      <${RowList} items=${papers.map(p => ({id: p.document.id, title: p.document.title, sub: p.datesUnavailable ? 'Dates unavailable' : p.expiry ? `Expires ${p.expiry}` : 'Expiry not indexed', end: {label: 'Open document', onClick: () => onOpen?.(p.document)}}))} empty=${{title: 'No indexed documents'}} />
      <h2>Renewals</h2>
      ${papers.some(p => p.renewal) ? papers.filter(p => p.renewal).map(p => html`<p>${p.document.title}: ${p.renewal}</p>`) : html`<p>No indexed renewals</p>`}
    `}
  <//>`;
}
