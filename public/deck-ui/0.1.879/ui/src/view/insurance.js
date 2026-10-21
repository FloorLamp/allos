import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {insuranceRow, policyStatus, coveredBy} from '../insurance.js';
import {dateText, fieldLabel} from '../format.js';
import {RowList} from './rows.js';
import {Facts} from './drawer.js';
import {RecordCard} from './record-card.js';
import {DetailList} from './detail-list.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
import {EntityLink, useEntityOpen} from './entity-link.js';
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
  const listPage = useCollectionPage(model.policies, {textOf: policyText, view, key: 'list'});
  return html`<main class="dk-insurance dk-page" aria-label="Insurance" aria-busy=${model.loading}>
    <${PageHeader} title="Insurance" description="Policies, coverage and linked documents." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${listPage} label="Search policies" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(insuranceRow)}
      current=${selected} onOpen=${(r, {page} = {}) => page && navigation ? navigation.openRecord(r.id) : select(r.id)} onClose=${() => select(null)}
      expand=${r => { const policy = model.policies.find(p => p.id === r.id); return policy ? html`<${PolicyCard} key=${policy.id} policy=${policy} host=${host} onOpen=${onOpen}
        onFull=${navigation ? () => navigation.openRecord(policy.id) : null} />` : null; }} loading=${model.loading && !model.policies.length ? 3 : 0}
      empty=${listPage.query ? {title: 'No policies match', line: 'Try another name, insurer or kind.', glyph: 'find'}
        : {title: 'No policies yet', line: 'Auto, home and other policies show here once they are indexed.', glyph: 'contract'}} /><${CollectionPager} page=${listPage} label="Policy pages" />
  </main>`;
}
// Who and what a policy covers: the insured person and the vehicles link to their records (entity-link.js); bridge gives the home
// only as an address (no property id), so it is named, not linked.
const COVERED = {Person: {glyph: 'person', kind: 'person'}, Property: {glyph: 'place', kind: null}, Vehicle: {glyph: 'car', kind: 'vehicle'}};
const coveredOf = policy => policy ? [
  ...(policy.insured ? [{...policy.insured, kind: 'Person'}] : []),
  ...(policy.home ? [{id: null, name: policy.home, kind: 'Property'}] : []),
  ...(policy.vehicles ?? []).map(v => ({...v, kind: 'Vehicle'})),
] : [];
const coveredLink = c => COVERED[c.kind].kind && c.id != null ? {kind: COVERED[c.kind].kind, id: c.id} : null;
/** Insured: the policy's person, linking to them. */
const insuredFact = (policy, host) => policy?.insured?.name ? {label: 'Insured', value: html`<${EntityLink} kind="person" id=${policy.insured.id} label=${policy.insured.name} host=${host} />`} : null;
/** A policy opened in place (the shared record card): its facts, who and what it covers (each linking to its record), its newest
 *  documents. */
export function PolicyCard({policy, host, onOpen, onFull}) {
  return html`<${RecordCard} label=${policy.name} facts=${policyFacts(policy)} onOpen=${onFull} groups=${[
    {key: 'covered', title: 'Covered', items: coveredOf(policy).map(c => ({id: `${c.kind}:${c.id ?? c.name}`, title: c.name, when: c.kind, glyph: COVERED[c.kind].glyph,
      link: coveredLink(c), host}))},
    {key: 'documents', title: 'Documents', items: [...(policy.documents ?? [])].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
      .map(d => ({id: d.id, title: d.title, date: d.date, when: dateText(d.date), glyph: 'document', link: {kind: 'document', id: d.id}, onOpen: () => onOpen?.(d)}))},
  ]} />`;
}
/** The canonical policy detail (the whole record: Open, Find's desktop pane); claims/documents and covered parties remain one implementation. */
export function PolicyDetail({policy, host, onOpen, view}) {
  const documents = policy?.documents ?? [], covered = coveredOf(policy), openEntity = useEntityOpen();
  return html`<section class="policy-detail" aria-label="Policy details">
      <${Facts} facts=${policy ? [insuredFact(policy, host), ...policyFacts(policy)].filter(Boolean) : []} />
      <${DetailList} title="Documents" view=${view} listKey="policy-documents" resetKey=${policy?.id} onOpen=${r => onOpen?.(r.doc)}
        items=${documents.map(d => ({id: d.id, title: d.title, date: d.date, doc: d}))} />
      <${DetailList} title="Covered" view=${view} listKey="policy-covered" resetKey=${policy?.id} sorted=${true}
        onOpen=${r => r.link && openEntity(r.link)}
        items=${covered.filter(c => c.kind !== 'Person').map(c => ({id: `${c.kind}:${c.id ?? c.name}`, title: c.name, sub: c.kind, glyph: COVERED[c.kind].glyph, link: coveredLink(c)}))} />
  </section>`;
}
