import {dateText, fieldLabel, joinText} from '../format.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useMemo, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {paperFacts, paperRow, paperState, renewalState, sortedPapers} from '../papers.js';
import {RowList} from './rows.js';
import {Facts} from './drawer.js';
import {RecordCard} from './record-card.js';
import {DetailList} from './detail-list.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
import {EntityLink} from './entity-link.js';
const html = htm.bind(h);
const paperText = p => [p.person?.name, p.kind, p.scope, p.number, p.expiry, paperState(p), renewalState(p), p.document?.title, p.renewal?.title, ...(p.documents ?? []).map(d => d.title)].join(' ');

/** A page's papers as rows: each holder's replaced papers folded into one `Replaced (n)` line at the group's end (`open`: the
 *  holders whose fold shows its papers in place). */
export function paperItems(papers, open) {
  const items = [];
  for (const p of papers) {
    const row = paperRow(p), last = items.at(-1);
    if (p.standing !== 'replaced') { items.push(row); continue; }
    if (last?.fold && last.section.key === row.section.key) { last.items.push(row); last.kinds.add(row.title); }
    else items.push({id: `replaced:${p.person.id}`, fold: true, glyph: 'archive', section: row.section, holder: p.person.id, items: [row], kinds: new Set([row.title])});
  }
  for (const it of items.filter(it => it.fold)) Object.assign(it, {title: `Replaced (${it.items.length})`, sub: [...it.kinds].join(', '), open: open(it.holder)});
  return items;
}

/** `links`: its own pages ({label, href}: navigation.js pageLinks), beside Refresh in the header. */
export function Papers({model, host, onOpen, navigation, view, links = []}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation), [opened, setOpened] = useState(() => new Set());
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const papers = useMemo(() => sortedPapers(model.papers), [model.papers]);
  const paper = papers.find(p => p.id === selected);
  const listPage = useCollectionPage(papers, {textOf: paperText, view, key: 'list'});
  // a search shows the replaced papers it matches; the paper a link opens shows in its place
  const open = holder => !!listPage.query.trim() || opened.has(holder) || paper?.person.id === holder && paper.standing === 'replaced';
  const fold = (it, isOpen) => setOpened(was => { const next = new Set(was); if (isOpen) next.add(it.holder); else next.delete(it.holder); return next; });
  return html`<main class="dk-papers dk-page" aria-label="Papers" aria-busy=${model.loading}>
    <${PageHeader} title="Papers" description="Identity papers, expiry dates and renewals." links=${links} actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${listPage} label="Search papers" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${paperItems(listPage.items, open)}
      current=${selected} onOpen=${(r, {page} = {}) => page && navigation ? navigation.openRecord(r.id) : select(r.id)} onClose=${() => select(null)} onFold=${fold}
      expand=${r => { const it = papers.find(p => p.id === r.id); return it ? html`<${PaperCard} key=${it.id} paper=${it} onOpen=${onOpen} holder=${false}
        onFull=${navigation ? () => navigation.openRecord(it.id, joinText([fieldLabel(it.kind), it.person?.name])) : null} />` : null; }} loading=${model.loading && !model.papers.length ? 3 : 0}
      empty=${listPage.query ? {title: 'No papers match', line: 'Try another name, kind or date.', glyph: 'find'}
        : {title: 'No identity papers yet', line: 'Passports, licences and IDs show here once they are indexed.', glyph: 'id'}} /><${CollectionPager} page=${listPage} label="Paper pages" />
  </main>`;
}
const documentsOf = paper => [...new Map([paper?.document, paper?.renewal, ...(paper?.documents ?? [])].filter(d => d?.id).map(d => [d.id, d])).values()];
/** Who holds it, linking to them (People). */
const holderFact = (paper, host) => paper?.person?.name ? {label: 'Holder', value: html`<${EntityLink} kind="person" id=${paper.person.id} label=${paper.person.name} host=${host} />`} : null;
/** A paper opened in place (the shared record card): its holder (`holder`: false under the holder's own heading), facts and documents,
 *  the renewal application named. */
export function PaperCard({paper, onOpen, onFull, host, holder = true}) {
  return html`<${RecordCard} label=${joinText([fieldLabel(paper.kind), paper.person?.name])} facts=${[holder ? holderFact(paper, host) : null, ...paperFacts(paper)].filter(Boolean)} onOpen=${onFull}
    groups=${[{key: 'documents', title: 'Documents', items: documentsOf(paper).map(d => ({id: d.id, title: d.title, date: d.date, glyph: 'document', link: {kind: 'document', id: d.id},
      when: d.id === paper.renewal?.id ? joinText(['Renewal', dateText(d.date)]) : dateText(d.date), onOpen: () => onOpen?.(d)}))}]} />`;
}
/** The same identity-paper detail in its collection's full view and Find. */
export function PaperDetail({paper, onOpen, view, host}) {
  const documents = documentsOf(paper);
  return html`<section class="paper-detail" aria-label="Paper details">
      <${Facts} facts=${paper ? [holderFact(paper, host), ...paperFacts(paper)].filter(Boolean) : []} />
      <${DetailList} title="Documents" view=${view} listKey="paper-documents" resetKey=${paper?.id} onOpen=${r => onOpen?.(r.doc)}
        items=${documents.map(d => ({id: d.id, title: d.title, date: d.date, doc: d,
          sub: d.id === paper?.renewal?.id ? joinText(['Renewal application', dateText(d.date)]) : dateText(d.date) || null}))} />
  </section>`;
}
