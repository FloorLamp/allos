import {usePageSelection} from './page-selection.js';
import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createThings, thingRow} from '../things.js';
import {resourcePath} from '../host/host.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);
// Specifications are metadata, but never index an accidentally embedded body or message history.
const specText = (value, depth = 0) => {
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  if (!value || depth >= 3) return '';
  return Object.entries(value).filter(([key]) => !/^(body|content|text|messages|history|conversations|raw|html)$/i.test(key))
    .flatMap(([key, next]) => [key, specText(next, depth + 1)]).join(' ');
};
const specificationText = ([key, value]) => `${key} ${specText(value)}`;
const thingText = thing => [thing.name, thing.kind, thing.type, thing.person?.name, thing.store, thing.brand, thing.model, thing.purchaseDate, thing.status,
  thing.variant?.size, thing.variant?.colour, specText(thing.specs), ...(thing.documents ?? []).map(d => d.title)].join(' ');

function Photo({image, host, name}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    const path = resourcePath(image?.url);
    if (path) Promise.resolve(host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [image?.url, host]);
  return src ? html`<img src=${src} alt=${name} loading="lazy" decoding="async" />` : html`<p>No indexed photo available</p>`;
}

export function Things({model, host, onOpen, navigation, view}) {
  const [selected, select] = usePageSelection(navigation);
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => {
    if (!navigation || model.loading) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (!selected) { if (model.id != null) model.close(); }
      else if (model.id !== selected && model.things.some(t => String(t.id) === selected)) model.open(selected);
    });
    return () => { active = false; };
  }, [navigation, selected, model.loading, model.things]);
  const thing = model.thing;
  const listPage = useCollectionPage(model.things, {textOf: thingText, view, key: 'list'});
  return html`<main class="dk-things" aria-label="Things" aria-busy=${model.loading}>
    <header><h1>Things</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    <${CollectionSearch} page=${listPage} label="Search things" loading=${model.loading} error=${model.error} />
    ${!model.error ? html`<${RowList} items=${listPage.items.map(thingRow)}
      onOpen=${r => navigation ? select(r.id) : model.open(r.id)} loading=${model.loading && !model.things.length ? 3 : 0} empty=${{title: listPage.query ? 'No things match' : 'No indexed things'}} /><${CollectionPager} page=${listPage} label="Thing pages" />` : null}
    <${Drawer} open=${model.id != null} title=${thing?.name ?? 'Thing'} onClose=${() => navigation ? select(null) : model.close()}>
      ${model.detailLoading ? html`<p role="status">Loading thing…</p>` : null}
      ${model.detailError ? html`<${Failure} backend="bridge" error=${model.detailError} retry=${() => model.open(model.id)} host=${host} />` : null}
      ${thing ? html`<${ThingDetail} thing=${thing} model=${model} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The canonical owned-product detail, shared with Find's product viewer. */
export function ThingDetail({thing, model, host, onOpen, view}) {
  const documents = thing?.documents ?? [];
  const specs = thing ? {...thing.specs, brand: thing.brand ?? thing.specs?.brand, model: thing.model ?? thing.specs?.model,
    size: thing.variant?.size, colour: thing.variant?.colour} : {};
  const documentPage = useCollectionPage(documents, {size: 20, resetKey: thing?.id, view, key: 'thing-documents'});
  const specPage = useCollectionPage(Object.entries(specs).filter(([, value]) => value != null), {textOf: specificationText, size: 20, resetKey: thing?.id, view, key: 'thing-specifications'});
  return html`<section class="thing-detail" aria-label="Thing details">
    <${StatTiles} label="Purchase" tiles=${[
        ...(thing.person?.name ? [{key: 'owner', label: 'Owner', value: thing.person.name}] : []),
        {key: 'store', label: 'Bought from', value: thing.store ?? 'Unknown'},
        {key: 'date', label: 'Bought on', value: thing.purchaseDate ?? 'Unknown'},
        {key: 'status', label: 'Status', value: thing.status ?? 'Unknown'},
        {key: 'price', label: 'Price', value: thing.price ?? 'Unknown'},
        {key: 'warranty', label: 'Warranty', value: thing.warranty ?? 'Unknown'},
        {key: 'return', label: 'Return window', value: thing.returnWindow ?? 'Unknown'},
      ]} />
      <h2>Specs</h2>
      <${CollectionSearch} page=${specPage} label="Search specifications" />
      <${RowList} items=${specPage.items.map(([key, value]) => ({id: key, title: key, sub: typeof value === 'object' ? JSON.stringify(value) : String(value)}))} empty=${{title: specPage.query ? 'No specifications match' : 'No indexed specs'}} />
      <${CollectionPager} page=${specPage} label="Specification pages" />
      <h2>Receipts and documents</h2>
      <${CollectionSearch} page=${documentPage} label="Search thing documents" />
      <${RowList} items=${documentPage.items.map(d => ({id: d.id, title: d.title, sub: d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: documentPage.query ? 'No documents match' : 'No indexed receipts or documents'}} />
      <${CollectionPager} page=${documentPage} label="Thing document pages" />
      <h2>Photos</h2><${Photo} image=${thing.image} name=${thing.name} host=${host} />
  </section>`;
}
export function ThingsPlace({host, onOpen, view, navigation}) {
  const [model] = useState(() => createThings(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Things} model=${model} host=${host} onOpen=${onOpen} view=${view} navigation=${navigation} />`;
}
