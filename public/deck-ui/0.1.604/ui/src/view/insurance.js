import {usePageSelection} from './page-selection.js';
import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createInsurance, insuranceRow, policyStatus, coveredBy} from '../insurance.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);
const policyText = p => [p.name, p.kind, p.number, p.insurer, coveredBy(p), p.renewal, p.term?.start, p.term?.end, policyStatus(p), ...(p.documents ?? []).map(d => d.title)].join(' ');

export function Insurance({model, host, onOpen, navigation, view}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const policy = model.policies.find(p => p.id === selected);
  const listPage = useCollectionPage(model.policies, {textOf: policyText, view, key: 'list'});
  return html`<main class="dk-insurance" aria-label="Insurance" aria-busy=${model.loading}>
    <header><h1>Insurance</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.warming ? html`<p role="status">Bridge is starting, updating…</p>` : null}
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    <${CollectionSearch} page=${listPage} label="Search policies" loading=${model.loading} error=${model.error} />
    ${!model.error ? html`<${RowList} items=${listPage.items.map(insuranceRow)}
      onOpen=${r => select(r.id)} loading=${model.loading && !model.policies.length ? 3 : 0} empty=${{title: listPage.query ? 'No policies match' : 'No indexed policies'}} /><${CollectionPager} page=${listPage} label="Policy pages" />` : null}
    <${Drawer} open=${!!policy} title=${policy?.name} onClose=${() => select(null)}>
      ${policy ? html`<${PolicyDetail} policy=${policy} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The canonical policy detail; claims/documents and linked people remain one implementation. */
export function PolicyDetail({policy, host, onOpen, view}) {
  const documents = policy?.documents ?? [];
  const documentPage = useCollectionPage(documents, {size: 20, resetKey: policy?.id, view, key: 'policy-documents'});
  const linked = policy ? [
    ...(policy.insured ? [{...policy.insured, kind: 'Person', query: policy.insured.name}] : []),
    ...(policy.home ? [{id: 'home', name: policy.home, kind: 'Property', query: policy.home}] : []),
    ...(policy.vehicles ?? []).map(v => ({...v, kind: 'Vehicle', query: v.name})),
  ] : [];
  const linkedPage = useCollectionPage(linked, {size: 20, resetKey: policy?.id, view, key: 'policy-links'});
  const openLink = link => host.call('url.open', {url: `https://deck.wang.team/?q=${encodeURIComponent(link.query)}`}).catch(() => {});
  return html`<section class="policy-detail" aria-label="Policy details">
      <p>${policy ? coveredBy(policy) : ''}</p>
      <${StatTiles} label="Policy" tiles=${policy ? [
        {key: 'kind', label: 'Kind', value: policy.kind ?? 'Unknown'},
        {key: 'insurer', label: 'Insurer', value: policy.insurer ?? 'Unknown'},
        {key: 'renewal', label: 'Renewal', value: policy.renewal ?? policy.term?.end ?? 'Unknown'},
        {key: 'status', label: 'Status', value: policyStatus(policy)},
      ] : []} />
      <h2>Documents</h2>
      <${CollectionSearch} page=${documentPage} label="Search policy documents" />
      <${RowList} items=${documentPage.items.map(d => ({id: d.id, title: d.title, sub: d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: documentPage.query ? 'No documents match' : 'No indexed documents'}} />
      <${CollectionPager} page=${documentPage} label="Policy document pages" />
      <h2>Linked people and property</h2>
      <${CollectionSearch} page=${linkedPage} label="Search policy links" />
      <${RowList} items=${linkedPage.items.map(l => ({id: `${l.kind}:${l.id}`, title: l.name, sub: l.kind,
        end: {label: `Open ${l.kind.toLowerCase()}`, onClick: () => openLink(l)}}))} empty=${{title: linkedPage.query ? 'No links match' : 'No indexed links'}} />
      <${CollectionPager} page=${linkedPage} label="Policy link pages" />
  </section>`;
}
export function InsurancePlace({host, onOpen, onPolicies, view, navigation}) {
  const [model] = useState(() => createInsurance(host));
  useEffect(() => {
    const unsubscribe = model.subscribe(() => { if (!model.loading) onPolicies?.(model.policies); });
    model.refresh();
    return () => { unsubscribe(); model.stop(); onPolicies?.(null); };
  }, [model]);
  return html`<${Insurance} model=${model} host=${host} onOpen=${onOpen} view=${view} navigation=${navigation} />`;
}
