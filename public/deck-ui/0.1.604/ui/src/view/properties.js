import {usePageSelection} from './page-selection.js';
import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createProperties, propertyRow} from '../properties.js';
import {paperDateText, paperSearchText} from '../collection-dates.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
const html = htm.bind(h);
const propertyText = home => [home.name, ...(home.aliases ?? []), ...(home.papers ?? []).map(paperSearchText)].join(' ');

export function Properties({model, host, onOpen, navigation, view}) {
  const [, redraw] = useState(0), [selected, select] = usePageSelection(navigation);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const home = model.homes.find(p => p.id === selected);
  const list = useCollectionPage(model.homes, {textOf: propertyText, view, key: 'list'});
  const rows = list.items.map(propertyRow);
  return html`<main class="dk-properties" aria-label="Properties" aria-busy=${model.loading}>
    <header><h1>Properties</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.warming ? html`<p role="status">Bridge is starting, updating…</p>` : null}
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    <${CollectionSearch} page=${list} label="Search properties" loading=${model.loading} error=${model.error} />
    ${!model.error ? html`<${RowList} items=${rows} onOpen=${r => select(r.id)} loading=${model.loading && !model.homes.length ? 3 : 0}
      empty=${{title: 'No indexed properties'}} />` : null}
    <${CollectionPager} page=${list} label="Property pages" />
    <${Drawer} open=${!!home} title=${home?.name} onClose=${() => select(null)}>
      ${home ? html`<${PropertyDetail} home=${home} model=${model} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The canonical property detail, used by both the collection and document viewer. */
export function PropertyDetail({home, model, host, onOpen, view}) {
  const papers = home?.papers ?? [];
  const documents = useCollectionPage(papers, {size: 20, textOf: paperSearchText, resetKey: home?.id, view, key: 'property-papers'});
  const visible = documents.items.map(p => p.document?.id ?? '').join(',');
  // Select membership before passive visible-date hydration; opening clears the previous date page.
  useLayoutEffect(() => { model.open(home?.id); return () => { model.open(null); }; }, [model, home]);
  useEffect(() => { if (home) model.visible(documents.items); }, [model, home, visible]);
  return html`<section class="property-detail" aria-label="Property details">
      <${StatTiles} label="Home papers" tiles=${[{key: 'papers', label: 'Indexed papers', quantity: {value: home?.paperCount ?? home?.count ?? papers.length}},
        {key: 'renewals', label: 'Recorded renewals', quantity: {value: papers.filter(p => p.renewal).length}}]} />
      ${model.detailLoading ? html`<p role="status">Loading paper dates…</p>` : null}
      ${model.warning ? html`<${Failure} backend="bridge" error=${model.warning} retry=${() => model.retryDates()} host=${host} />` : null}
      <h2>Papers</h2>
      <${CollectionSearch} page=${documents} label="Search property papers" />
      <${RowList} items=${documents.items.map((p, i) => ({id: `${p.document?.id}:${i}`, title: p.document?.title ?? p.kind,
        sub: `${p.kind} · ${paperDateText(p)}`,
        end: p.document?.id ? {label: 'Open paper', onClick: () => onOpen?.(p.document)} : null}))} empty=${{title: 'No indexed papers'}} />
      <${CollectionPager} page=${documents} label="Property paper pages" />
      <h2>Renewals</h2>
      ${documents.items.some(p => p.renewal) ? documents.items.filter(p => p.renewal).map(p => html`<p>${p.kind}: ${p.renewal}</p>`) : html`<p>${model.warning ? 'Renewal dates unavailable' : model.detailLoading ? 'Checking renewal dates…' : 'No indexed renewals in these papers'}</p>`}
      ${home?.missing?.length ? html`<p>Not indexed: ${home.missing.join(', ')}</p>` : null}
  </section>`;
}
export function PropertiesPlace({host, onOpen, view, navigation}) {
  const [model] = useState(() => createProperties(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Properties} model=${model} host=${host} onOpen=${onOpen} view=${view} navigation=${navigation} />`;
}
