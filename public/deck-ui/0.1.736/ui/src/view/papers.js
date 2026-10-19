import {collectionLabel} from '../collection-label.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPapers, paperRow, paperState, renewalState, sortedPapers} from '../papers.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);
const paperText = p => [p.person?.name, p.kind, p.scope, p.number, p.expiry, paperState(p), renewalState(p), p.document?.title, p.renewal?.title, ...(p.documents ?? []).map(d => d.title)].join(' ');

export function Papers({model, host, onOpen, navigation, view}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const paper = model.papers.find(p => p.id === selected);
  const listPage = useCollectionPage(sortedPapers(model.papers), {textOf: paperText, view, key: 'list'});
  return html`<main class="dk-papers dk-page" aria-label="Papers" aria-busy=${model.loading}>
    <${PageHeader} title="Papers" description="Identity papers, expiry dates and renewals." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${listPage} label="Search papers" loading=${model.loading} error=${model.error} />
    <${RowList} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(paperRow)}
      onOpen=${r => select(r.id)} loading=${model.loading && !model.papers.length ? 3 : 0} empty=${{title: listPage.query ? 'No papers match' : 'No indexed identity papers'}} /><${CollectionPager} page=${listPage} label="Paper pages" />
    <${Drawer} open=${!!paper} title=${paper ? `${paper.person.name} · ${collectionLabel(paper.kind)}` : ''} onClose=${() => select(null)}>
      ${paper ? html`<${PaperDetail} paper=${paper} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The same identity-paper detail in its collection and Find. */
export function PaperDetail({paper, host, onOpen, view}) {
  const documents = [...new Map([paper?.document, paper?.renewal, ...(paper?.documents ?? [])].filter(d => d?.id).map(d => [d.id, d])).values()];
  const documentPage = useCollectionPage(documents, {size: 20, resetKey: paper?.id, view, key: 'paper-documents'});
  return html`<section class="paper-detail" aria-label="Paper details">
      <${StatTiles} label="Identity paper" tiles=${paper ? [
        {key: 'scope', label: 'Scope', value: collectionLabel(paper.scope) || 'Unknown'},
        {key: 'expiry', label: 'Expiry', value: paper.expiry ?? 'Unknown'},
        {key: 'state', label: 'State', value: paperState(paper)},
        {key: 'renewal', label: 'Renewal', value: renewalState(paper)},
      ] : []} />
      <h2>Documents and renewal application</h2>
      <${CollectionSearch} page=${documentPage} label="Search paper documents" />
      <${RowList} items=${documentPage.items.map(d => ({id: d.id, title: d.title, sub: d.id === paper?.renewal?.id ? 'Pending renewal application' : d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: documentPage.query ? 'No documents match' : 'No indexed documents'}} />
      <${CollectionPager} page=${documentPage} label="Paper document pages" />
  </section>`;
}
export function PapersPlace({host, onOpen, view, navigation}) {
  const [model] = useState(() => createPapers(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Papers} model=${model} host=${host} onOpen=${onOpen} view=${view} navigation=${navigation} />`;
}
