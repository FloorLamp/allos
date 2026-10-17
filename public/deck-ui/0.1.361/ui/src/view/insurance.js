import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createInsurance, insuranceRow, policyStatus, coveredBy} from '../insurance.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
const html = htm.bind(h);

export function Insurance({model, host, onOpen}) {
  const [, redraw] = useState(0), [selected, select] = useState(null);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const policy = model.policies.find(p => p.id === selected);
  const documents = policy?.documents ?? [];
  const linked = policy ? [
    ...(policy.insured ? [{...policy.insured, kind: 'Person', query: policy.insured.name}] : []),
    ...(policy.home ? [{id: 'home', name: policy.home, kind: 'Property', query: policy.home}] : []),
    ...(policy.vehicles ?? []).map(v => ({...v, kind: 'Vehicle', query: v.name})),
  ] : [];
  const openLink = link => host.call('url.open', {url: `https://deck.wang.team/?q=${encodeURIComponent(link.query)}`}).catch(() => {});
  return html`<main class="dk-insurance" aria-label="Insurance" aria-busy=${model.loading}>
    <header><h1>Insurance</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.error ? html`<${RowList} items=${model.policies.map(insuranceRow)}
      onOpen=${r => select(r.id)} loading=${model.loading ? 3 : 0} empty=${{title: 'No indexed policies'}} />` : null}
    <${Drawer} open=${!!policy} title=${policy?.name} onClose=${() => select(null)}>
      <p>${policy ? coveredBy(policy) : ''}</p>
      <${StatTiles} label="Policy" tiles=${policy ? [
        {key: 'kind', label: 'Kind', value: policy.kind ?? 'Unknown'},
        {key: 'insurer', label: 'Insurer', value: policy.insurer ?? 'Unknown'},
        {key: 'renewal', label: 'Renewal', value: policy.renewal ?? policy.term?.end ?? 'Unknown'},
        {key: 'status', label: 'Status', value: policyStatus(policy)},
      ] : []} />
      <h2>Documents</h2>
      <${RowList} items=${documents.map(d => ({id: d.id, title: d.title, sub: d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: 'No indexed documents'}} />
      <h2>Linked people and property</h2>
      <${RowList} items=${linked.map(l => ({id: `${l.kind}:${l.id}`, title: l.name, sub: l.kind,
        end: {label: `Open ${l.kind.toLowerCase()}`, onClick: () => openLink(l)}}))} empty=${{title: 'No indexed links'}} />
    <//>
  </main>`;
}
export function InsurancePlace({host, onOpen, onPolicies}) {
  const [model] = useState(() => createInsurance(host));
  useEffect(() => {
    const unsubscribe = model.subscribe(() => { if (!model.loading) onPolicies?.(model.policies); });
    model.refresh();
    return () => { unsubscribe(); model.stop(); onPolicies?.(null); };
  }, [model]);
  return html`<${Insurance} model=${model} host=${host} onOpen=${onOpen} />`;
}
