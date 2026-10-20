import {dateText, fieldLabel, joinText} from '../format.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {paperFacts, paperRow, paperState, renewalState, sortedPapers} from '../papers.js';
import {RowList} from './rows.js';
import {Drawer, Facts} from './drawer.js';
import {DetailList} from './detail-list.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);
const paperText = p => [p.person?.name, p.kind, p.scope, p.number, p.expiry, paperState(p), renewalState(p), p.document?.title, p.renewal?.title, ...(p.documents ?? []).map(d => d.title)].join(' ');

/** `links`: the host's related pages ({label, href}), beside Refresh in the header. */
export function Papers({model, host, onOpen, navigation, view, links = []}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const paper = model.papers.find(p => p.id === selected);
  const listPage = useCollectionPage(sortedPapers(model.papers), {textOf: paperText, view, key: 'list'});
  return html`<main class="dk-papers dk-page" aria-label="Papers" aria-busy=${model.loading}>
    <${PageHeader} title="Papers" description="Identity papers, expiry dates and renewals." actions=${html`${links.map(link => html`<a key=${link.href} class="dk-btn" href=${link.href}>${link.label}</a>`)}<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${listPage} label="Search papers" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(paperRow)}
      onOpen=${r => select(r.id)} loading=${model.loading && !model.papers.length ? 3 : 0}
      empty=${listPage.query ? {title: 'No papers match', line: 'Try another name, kind or date.', glyph: 'find'}
        : {title: 'No identity papers yet', line: 'Passports, licences and IDs show here once they are indexed.', glyph: 'id'}} /><${CollectionPager} page=${listPage} label="Paper pages" />
    <${Drawer} open=${!!paper} title=${paper ? fieldLabel(paper.kind) : ''} sub=${paper?.person.name} onClose=${() => select(null)}>
      ${paper ? html`<${PaperDetail} paper=${paper} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The same identity-paper detail in its collection and Find. */
export function PaperDetail({paper, onOpen, view}) {
  const documents = [...new Map([paper?.document, paper?.renewal, ...(paper?.documents ?? [])].filter(d => d?.id).map(d => [d.id, d])).values()];
  return html`<section class="paper-detail" aria-label="Paper details">
      <${Facts} facts=${paper ? paperFacts(paper) : []} />
      <${DetailList} title="Documents" view=${view} listKey="paper-documents" resetKey=${paper?.id} onOpen=${r => onOpen?.(r.doc)}
        items=${documents.map(d => ({id: d.id, title: d.title, date: d.date, doc: d,
          sub: d.id === paper?.renewal?.id ? joinText(['Renewal application', dateText(d.date)]) : dateText(d.date) || null}))} empty="No indexed documents" />
  </section>`;
}
