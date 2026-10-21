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
import {Facts, SectionHead} from './drawer.js';
import {RecordCard} from './record-card.js';
import {DetailList} from './detail-list.js';
import {Later} from './deferred.js';
const html = htm.bind(h);
const propertyText = home => [home.name, ...(home.aliases ?? []), ...(home.papers ?? []).map(paperSearchText)].join(' ');

export function Properties({model, host, onOpen, navigation, view}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const list = useCollectionPage(model.homes, {textOf: propertyText, view, key: 'list'});
  const rows = list.items.map(propertyRow);
  return html`<main class="dk-properties dk-page" aria-label="Properties" aria-busy=${model.loading}>
    <${PageHeader} title="Properties" description="Property records, documents and renewals." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${list} label="Search properties" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${rows} loading=${model.loading && !model.homes.length ? 3 : 0}
      current=${selected} onOpen=${(r, {page} = {}) => page && navigation ? navigation.openRecord(r.id) : select(r.id)} onClose=${() => select(null)}
      expand=${r => { const home = model.homes.find(p => p.id === r.id); return home ? html`<${PropertyCard} key=${home.id} home=${home} model=${model} host=${host} onOpen=${onOpen}
        onFull=${navigation ? () => navigation.openRecord(home.id) : null} />` : null; }}
      empty=${list.query ? {title: 'No properties match', line: 'Try another address or paper.', glyph: 'find'}
        : {title: 'No properties yet', line: 'Homes show here with their deeds, bills and permits once they are indexed.', glyph: 'house'}} />
    <${CollectionPager} page=${list} label="Property pages" />
  </main>`;
}
const paperItem = (p, i) => ({id: `${p.document?.id}:${i}`, title: p.document?.title ?? fieldLabel(p.kind), date: p.document?.date, paper: p});
/** A property opened in place (the shared record card): its renewals and newest papers, their dates read for the ones shown. */
export function PropertyCard({home, model, onOpen, onFull}) {
  const papers = [...(home.papers ?? [])].map(paperItem).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  useLayoutEffect(() => { model.open(home.id); return () => { model.open(null); }; }, [model, home.id]);
  const first = papers.slice(0, 5).map(r => r.paper);
  useEffect(() => { model.visible(first); }, [model, home.id, first.map(p => p.document?.id).join(',')]);
  // the newest paper of each kind shown says its renewal or expiry, once
  const kinds = [...new Map(first.filter(p => p.renewal || p.expiry).map(p => [p.kind, p])).values()];
  const facts = [
    {label: 'Also called', value: (home.aliases ?? []).filter(a => a !== home.name).join(', ') || null},
    ...kinds.map(p => p.renewal ? {label: `${fieldLabel(p.kind)} renewal`, value: dateText(p.renewal)} : {label: `${fieldLabel(p.kind)} expires`, value: dateText(p.expiry)}),
  ];
  return html`<${RecordCard} label=${home.name} facts=${facts} onOpen=${onFull}
    groups=${[{key: 'papers', title: 'Papers', items: papers.map(r => ({id: r.id, title: r.title, date: r.date, when: dateText(r.date), glyph: 'document',
      link: r.paper.document?.id ? {kind: 'document', id: r.paper.document.id} : null, onOpen: () => r.paper.document?.id && onOpen?.(r.paper.document)}))}]} />`;
}
/** The canonical property detail: the whole record (Open) and Find's desktop pane: its place and Habitat's zones near it
 *  (contract/media.md *Map*), its papers, its renewals. */
export function PropertyDetail({home, model, host, onOpen, view}) {
  const papers = home?.papers ?? [];
  // Select membership before passive visible-date hydration; opening clears the previous date page.
  useLayoutEffect(() => { model.open(home?.id); return () => { model.open(null); }; }, [model, home]);
  const renewals = papers.filter(p => p.renewal);
  const missing = home?.missing?.length ? `Not indexed: ${home.missing.map(fieldLabel).join(', ')}` : null;
  return html`<section class="property-detail" aria-label="Property details">
      ${home ? html`<${Later} name="PropertyArea" host=${host} home=${home} />` : null}
      ${model.warning ? html`<${Failure} backend="bridge" error=${model.warning} retry=${() => model.retryDates()} host=${host} />` : null}
      <${DetailList} title="Papers" view=${view} listKey="property-papers" resetKey=${home?.id} onOpen=${r => r.paper.document?.id && onOpen?.(r.paper.document)}
        onVisible=${items => { if (home) model.visible(items.map(r => r.paper)); }} note=${missing}
        items=${papers.map((p, i) => ({...paperItem(p, i),
          sub: joinText([fieldLabel(p.kind), p.expiry ? `Expires ${dateText(p.expiry)}` : p.datesLoading ? 'Checking dates…' : null, p.document?.date && !p.expiry ? dateText(p.document.date) : null])}))} />
      ${renewals.length ? html`<section class="dk-section" aria-label="Renewals"><${SectionHead} level=${3} title="Renewals" meta=${countText(renewals.length)} />
        <${Facts} facts=${renewals.map(p => ({label: fieldLabel(p.kind), value: dateText(p.renewal)}))} /></section>` : null}
  </section>`;
}
