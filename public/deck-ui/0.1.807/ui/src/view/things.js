import {physicalThingId} from '../physical-thing.js';
import {PhysicalThing} from './physical-thing.js';
import {Purchases} from './purchases.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {Failure, StateBlock} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {thingRow, thingSpecs} from '../things.js';
import {resourcePath} from '../host/host.js';
import {RowList} from './rows.js';
import {dateText, fieldLabel} from '../format.js';
import {amountText} from '../quantity.js';
import {Drawer, Facts, Section} from './drawer.js';
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
const specificationText = fact => `${fact.label} ${fact.value}`;
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
  return src ? html`<img src=${src} alt=${name} loading="lazy" decoding="async" />` : html`<${StateBlock} inline=${true} line="No indexed photo" />`;
}

export function Things({model, host, onOpen, navigation, view}) {
  const [purchases, setPurchases] = useState(false), [purchasesKey, reloadPurchases] = useState(0);
  const [selected, select] = usePageSelection(navigation);
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => {
    if (!navigation || model.loading) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (!selected) { if (model.id != null) model.close(); }
      else if (model.id !== selected && (physicalThingId(selected) || model.things.some(t => String(t.id) === selected))) model.open(selected);
    });
    return () => { active = false; };
  }, [navigation, selected, model.loading, model.things]);
  const thing = model.thing;
  // a physical thing's name comes with its own read; the listed product's names it meanwhile
  const [physical, setPhysical] = useState(null);
  const listed = model.id == null ? null : model.things.find(t => t.thingId === model.id || t.id === model.id);
  useEffect(() => { if (physical && physical.id !== model.id) setPhysical(null); }, [model.id]);
  const listPage = useCollectionPage(model.things, {textOf: thingText, view, key: 'list'});
  const list = html`<${CollectionSearch} page=${listPage} label="Search things" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(thingRow)}
      onOpen=${r => {
        const id = model.things.find(thing => thing.id === r.id)?.thingId ?? r.id;
        return navigation ? select(id) : model.open(id);
      }} loading=${model.loading && !model.things.length ? 3 : 0} empty=${{title: listPage.query ? 'No things match' : 'No indexed things'}} /><${CollectionPager} page=${listPage} label="Thing pages" />`;
  return html`<main class="dk-things dk-page" aria-label="Things" aria-busy=${model.loading}>
    <${PageHeader} title="Things" description="Purchases, warranties and their documents." actions=${html`<button class="dk-btn" type="button" aria-expanded=${purchases} onClick=${() => setPurchases(!purchases)}>Purchases</button>
      <button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => { model.refresh(); if (purchases) reloadPurchases(n => n + 1); }}>Refresh</button>`} />
    ${purchases ? html`<${Purchases} embedded refreshKey=${purchasesKey} host=${host} onOpen=${onOpen} />` : null}
    ${purchases ? html`<${Section} title="Owned things">${list}<//>` : list}
    <${Drawer} open=${model.id != null} title=${thing?.name ?? physical?.name ?? listed?.name ?? 'Thing'} onClose=${() => navigation ? select(null) : model.close()}>
      ${model.detailLoading ? html`<p role="status">Loading thing…</p>` : null}
      ${model.detailError ? html`<${Failure} backend="bridge" error=${model.detailError} retry=${() => model.open(model.id)} host=${host} />` : null}
      ${physicalThingId(model.id) ? html`<${PhysicalThing} id=${model.id} host=${host} onOpen=${onOpen} heading=${false} onThing=${setPhysical} />` : thing ? html`<${ThingDetail} thing=${thing} model=${model} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
  </main>`;
}
/** The canonical owned-product detail, shared with Find's product viewer. */
export function ThingDetail(props) {
  return props.thing?.thingId ? html`<${PhysicalThing} id=${props.thing.thingId} host=${props.host} onOpen=${props.onOpen} />`
    : html`<${ProductDetail} ...${props} />`;
}
function ProductDetail({thing, model, host, onOpen, view}) {
  const documents = thing?.documents ?? [];
  const specs = thingSpecs(thing);
  const documentPage = useCollectionPage(documents, {size: 20, resetKey: thing?.id, view, key: 'thing-documents'});
  const specPage = useCollectionPage(specs, {textOf: specificationText, size: 20, resetKey: thing?.id, view, key: 'thing-specifications'});
  // figures that are known are tiles; the rest are facts, so no tile says "Unknown"
  const purchase = [
    {key: 'price', label: 'Price', value: amountText(thing.price)},
    {key: 'date', label: 'Bought on', value: thing.purchaseDate ? dateText(thing.purchaseDate) : null},
    {key: 'store', label: 'Bought from', value: thing.store},
    {key: 'owner', label: 'Owner', value: thing.person?.name},
  ].filter(t => t.value != null && t.value !== '');
  // only what is known; Things lists owned products, so Owned says nothing
  const terms = [
    {label: 'Status', value: thing.status && thing.status !== 'owned' ? fieldLabel(thing.status) : null},
    {label: 'Warranty', value: thing.warranty ? dateText(thing.warranty) : null},
    {label: 'Return window', value: thing.returnWindow ? dateText(thing.returnWindow) : null},
  ].filter(f => f.value);
  return html`<section class="thing-detail" aria-label="Thing details">
    ${purchase.length ? html`<${StatTiles} label="Purchase" tiles=${purchase} />` : null}
    ${terms.length ? html`<${Facts} facts=${terms} />` : null}
    ${specs.length ? html`<${Section} title="Specs">
      <${CollectionSearch} page=${specPage} label="Search specifications" />
      <${Facts} facts=${specPage.items} />
      ${!specPage.items.length ? html`<${StateBlock} inline=${true} line="No specifications match" />` : null}
      <${CollectionPager} page=${specPage} label="Specification pages" /><//>` : null}
    <${Section} title="Receipts and documents">
      <${CollectionSearch} page=${documentPage} label="Search thing documents" />
      <${RowList} inline=${true} items=${documentPage.items.map(d => ({id: d.id, title: d.title, sub: dateText(d.date),
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: documentPage.query ? 'No documents match' : 'No indexed receipts or documents'}} />
      <${CollectionPager} page=${documentPage} label="Thing document pages" /><//>
    <${Section} title="Photos"><${Photo} image=${thing.image} name=${thing.name} host=${host} /><//>
  </section>`;
}
