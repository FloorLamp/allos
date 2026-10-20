import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {insuranceRow, policyStatus, coveredBy} from '../insurance.js';
import {dateText, fieldLabel} from '../format.js';
import {RowList} from './rows.js';
import {Drawer, Facts} from './drawer.js';
import {DetailList} from './detail-list.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);
/** A policy's facts, only what is known: kind as people read it, insurer, renewal, status. */
export const policyFacts = policy => [
  {label: 'Kind', value: policy.kind ? fieldLabel(policy.kind) : null},
  {label: 'Insurer', value: policy.insurer},
  {label: 'Policy', value: policy.number},
  {label: 'Renewal', value: dateText(policy.renewal ?? policy.term?.end) || null},
  {label: 'Status', value: policyStatus(policy)},
].filter(fact => fact.value && !/^(?:status )?unknown$/i.test(String(fact.value).trim()));
const policyText = p => [p.name, p.kind, p.number, p.insurer, coveredBy(p), p.renewal, p.term?.start, p.term?.end, policyStatus(p), ...(p.documents ?? []).map(d => d.title)].join(' ');

export function Insurance({model, host, onOpen, navigation, view}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const policy = model.policies.find(p => p.id === selected);
  const listPage = useCollectionPage(model.policies, {textOf: policyText, view, key: 'list'});
  return html`<main class="dk-insurance dk-page" aria-label="Insurance" aria-busy=${model.loading}>
    <${PageHeader} title="Insurance" description="Policies, coverage and linked documents." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${listPage} label="Search policies" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(insuranceRow)}
      onOpen=${r => select(r.id)} loading=${model.loading && !model.policies.length ? 3 : 0}
      empty=${listPage.query ? {title: 'No policies match', line: 'Try another name, insurer or kind.', glyph: 'find'}
        : {title: 'No policies yet', line: 'Auto, home and other policies show here once they are indexed.', glyph: 'contract'}} /><${CollectionPager} page=${listPage} label="Policy pages" />
    <${Drawer} open=${!!policy} title=${policy?.name} onClose=${() => select(null)}>
      ${policy ? html`<${PolicyDetail} policy=${policy} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
// A covered party opens its own collection's drawer (same origin), never a search in a new tab.
const COVERED = {Person: {glyph: 'person', path: '/people'}, Property: {glyph: 'house', path: '/properties'}, Vehicle: {glyph: 'car', path: '/vehicles'}};
/** The canonical policy detail; claims/documents and covered parties remain one implementation. */
export function PolicyDetail({policy, host, onOpen, view}) {
  const documents = policy?.documents ?? [];
  const covered = policy ? [
    ...(policy.insured ? [{...policy.insured, kind: 'Person'}] : []),
    ...(policy.home ? [{id: null, name: policy.home, kind: 'Property'}] : []),
    ...(policy.vehicles ?? []).map(v => ({...v, kind: 'Vehicle'})),
  ] : [];
  const openCovered = c => {
    const page = `${COVERED[c.kind].path}${c.id != null ? `#${encodeURIComponent(c.id)}` : ''}`;
    if (host?.kind === 'web') globalThis.location.assign(page);
    else host?.call('url.open', {url: `https://deck.wang.team${page}`}).catch(() => {});
  };
  return html`<section class="policy-detail" aria-label="Policy details">
      <${Facts} facts=${policy ? policyFacts(policy) : []} />
      <${DetailList} title="Documents" view=${view} listKey="policy-documents" resetKey=${policy?.id} onOpen=${r => onOpen?.(r.doc)}
        items=${documents.map(d => ({id: d.id, title: d.title, date: d.date, doc: d}))} empty="No indexed documents" />
      <${DetailList} title="Covered" view=${view} listKey="policy-covered" resetKey=${policy?.id} sorted=${true}
        onOpen=${r => openCovered(r.covered)} empty="Covered party not indexed"
        items=${covered.map(c => ({id: `${c.kind}:${c.id ?? c.name}`, title: c.name, sub: c.kind, glyph: COVERED[c.kind].glyph, covered: c}))} />
  </section>`;
}
