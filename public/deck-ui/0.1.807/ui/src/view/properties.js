import {countText, dateText, fieldLabel, joinText} from '../format.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {Failure} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {propertyRow} from '../properties.js';
import {paperSearchText} from '../collection-dates.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
import {RowList} from './rows.js';
import {Drawer, Facts, SectionHead} from './drawer.js';
import {DetailList} from './detail-list.js';
const html = htm.bind(h);
const propertyText = home => [home.name, ...(home.aliases ?? []), ...(home.papers ?? []).map(paperSearchText)].join(' ');

export function Properties({model, host, onOpen, navigation, view}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const home = model.homes.find(p => p.id === selected);
  const list = useCollectionPage(model.homes, {textOf: propertyText, view, key: 'list'});
  const rows = list.items.map(propertyRow);
  return html`<main class="dk-properties dk-page" aria-label="Properties" aria-busy=${model.loading}>
    <${PageHeader} title="Properties" description="Property records, documents and renewals." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${list} label="Search properties" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${rows} onOpen=${r => select(r.id)} loading=${model.loading && !model.homes.length ? 3 : 0}
      empty=${list.query ? {title: 'No properties match', line: 'Try another address or paper.', glyph: 'find'}
        : {title: 'No properties yet', line: 'Homes show here with their deeds, bills and permits once they are indexed.', glyph: 'house'}} />
    <${CollectionPager} page=${list} label="Property pages" />
    <${Drawer} open=${!!home} title=${home?.name} onClose=${() => select(null)}>
      ${home ? html`<${PropertyDetail} home=${home} model=${model} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The canonical property detail, used by both the collection and document viewer. */
export function PropertyDetail({home, model, host, onOpen, view}) {
  const papers = home?.papers ?? [];
  // Select membership before passive visible-date hydration; opening clears the previous date page.
  useLayoutEffect(() => { model.open(home?.id); return () => { model.open(null); }; }, [model, home]);
  const renewals = papers.filter(p => p.renewal);
  const missing = home?.missing?.length ? `Not indexed: ${home.missing.map(fieldLabel).join(', ')}` : null;
  return html`<section class="property-detail" aria-label="Property details">
      ${model.warning ? html`<${Failure} backend="bridge" error=${model.warning} retry=${() => model.retryDates()} host=${host} />` : null}
      <${DetailList} title="Papers" view=${view} listKey="property-papers" resetKey=${home?.id} onOpen=${r => r.paper.document?.id && onOpen?.(r.paper.document)}
        onVisible=${items => { if (home) model.visible(items.map(r => r.paper)); }} note=${missing} empty="No indexed papers"
        items=${papers.map((p, i) => ({id: `${p.document?.id}:${i}`, title: p.document?.title ?? fieldLabel(p.kind), date: p.document?.date, paper: p,
          sub: joinText([fieldLabel(p.kind), p.expiry ? `Expires ${dateText(p.expiry)}` : p.datesLoading ? 'Checking dates…' : null, p.document?.date && !p.expiry ? dateText(p.document.date) : null])}))} />
      <section class="dk-section" aria-label="Renewals"><${SectionHead} level=${3} title="Renewals" meta=${renewals.length ? countText(renewals.length) : null} />
        ${renewals.length ? html`<${Facts} facts=${renewals.map(p => ({label: fieldLabel(p.kind), value: dateText(p.renewal)}))} />`
          : html`<p class="dk-note">${model.warning ? 'Renewal dates unavailable' : model.detailLoading ? 'Checking renewal dates…' : 'No renewals recorded in these papers'}</p>`}</section>
  </section>`;
}
