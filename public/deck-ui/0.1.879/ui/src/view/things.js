import {HabitatThings} from './habitat-things.js';
import {createPhysicalThing} from '../physical-thing.js';
import {physicalThingId} from '../collection-target.js';
import {houseUnavailable, hubLines, thingPapers} from '../thing-hub.js';
import {stateText} from '../house.js';
import {PhysicalThing} from './physical-thing.js';
import {Purchases} from './purchases.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {Failure, StateBlock} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import {NewThingDrawer} from './thing-links.js';
import {canLink, thingPage} from '../thing-links.js';
import htm from '../../vendor/htm.mjs';
import {sharedThings, thingRow, thingSpecs} from '../things.js';
import {ProductTile} from './product-tile.js';
import {resourcePath} from '../host/host.js';
import {RowList} from './rows.js';
import {dateText, fieldLabel} from '../format.js';
import {amountText} from '../quantity.js';
import {Facts, Section} from './drawer.js';
import {RecordCard} from './record-card.js';
import {EntityLink} from './entity-link.js';
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

export function Things({model, host, onOpen, navigation, view}) {
  const [purchases, setPurchases] = useState(false), [purchasesKey, reloadPurchases] = useState(0);
  const [selected, select] = usePageSelection(navigation);
  const [, redraw] = useState(0), [creating, setCreating] = useState(false);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  // a link to a physical thing no listed row names (`/things#<UUID>`: an owner-made thing, a House device's): its full view, once
  const shown = useRef(null);
  useEffect(() => {
    if (!navigation || model.loading) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (selected && physicalThingId(selected) && shown.current !== selected && navigation.record !== selected
        && !model.things.some(t => t.thingId === selected || String(t.id) === selected)) { shown.current = selected; navigation.openRecord(selected); return; }
      if (!selected) { if (model.id != null) model.close(); }
      else if (model.id !== selected && (physicalThingId(selected) || model.things.some(t => String(t.id) === selected))) {
        model.open(selected);
        // a thing no listed row is (a house record, a thing linked from elsewhere): its page, the whole record, over the list
        if (physicalThingId(selected) && !model.things.some(t => t.thingId === selected || t.id === selected)) navigation.openRecord(selected);
      }
    });
    return () => { active = false; };
  }, [navigation, selected, model.loading, model.things]);
  // the open row: the listed thing the open id names (a physical thing's own id, or the product's)
  const openRow = model.id == null ? null : model.things.find(t => t.thingId === model.id || t.id === model.id)?.id ?? null;
  const listPage = useCollectionPage(model.things, {textOf: thingText, view, key: 'list'});
  // the owner and store every thing has are said by no row; each row its product's photo when bridge has one
  const shared = sharedThings(model.things);
  const list = html`<${CollectionSearch} page=${listPage} label="Search things" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(t => ({...thingRow(t, shared), tile: h(ProductTile, {host, image: t.image, glyph: t.type === 'plant' ? 'plant' : 'thing'})}))}
      current=${openRow}
      onOpen=${(r, {page} = {}) => {
        const it = model.things.find(thing => thing.id === r.id), id = it?.thingId ?? r.id;
        if (page && navigation) return navigation.openRecord(id, it?.name);
        return navigation ? select(id) : model.open(id);
      }} onClose=${() => navigation ? select(null) : model.close()}
      expand=${r => {
        const it = model.things.find(t => t.id === r.id), id = it?.thingId ?? r.id;
        if (!it || model.id !== id) return null;
        if (model.detailError) return html`<${Failure} backend="bridge" error=${model.detailError} retry=${() => model.open(model.id)} host=${host} />`;
        return html`<${ThingCard} key=${id} listed=${it} thing=${model.thing} loading=${model.detailLoading} host=${host} onOpen=${onOpen}
          onFull=${navigation ? () => navigation.openRecord(id, model.thing?.name ?? it.name) : null} />`;
      }}
      loading=${model.loading && !model.things.length ? 3 : 0} empty=${{title: listPage.query ? 'No things match' : 'No indexed things'}} /><${CollectionPager} page=${listPage} label="Thing pages" />`;
  return html`<main class="dk-things dk-page" aria-label="Things" aria-busy=${model.loading}>
    <${PageHeader} title="Things" description="Devices, electricity, purchases and warranties." actions=${html`${canLink(host) ? html`<button class="dk-btn" type="button" onClick=${() => setCreating(true)}>New thing</button>` : null}
      <button class="dk-btn" type="button" aria-expanded=${purchases} onClick=${() => setPurchases(!purchases)}>Purchases</button>
      <button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => { model.refresh(); if (purchases) reloadPurchases(n => n + 1); }}>Refresh</button>`} />
    ${host.backends?.includes('habitat') ? html`<${HabitatThings} host=${host} />` : null}
    ${purchases ? html`<${Purchases} embedded refreshKey=${purchasesKey} host=${host} onOpen=${onOpen} />` : null}
    ${purchases ? html`<${Section} title="Owned things">${list}<//>` : list}
    ${creating ? html`<${NewThingDrawer} host=${host} onClose=${() => setCreating(false)} onCreated=${thing => {
      setCreating(false); shown.current = thing.id;
      if (navigation) navigation.openRecord(thing.id, thing.name); else globalThis.location?.assign(thingPage(thing.id));
    }} />` : null}
  </main>`;
}
function Thumb({image, host, name}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    const path = resourcePath(image?.url);
    if (path) Promise.resolve(host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [image?.url, host]);
  return src ? html`<img class="thing-card-photo" src=${src} alt=${name} loading="lazy" decoding="async" />` : null;
}
/** A thing opened in place (the shared record card): what the list knows at once, then its read (a product's specs, terms, receipts);
 *  a house record (a physical thing) its whole record behind Open. */
export function ThingCard({listed, thing, loading = false, host, onOpen, onFull}) {
  if (physicalThingId(listed?.thingId)) return html`<${PhysicalCard} key=${listed.thingId} id=${listed.thingId} detail=${listed.detail ?? null} listed=${listed} host=${host} onOpen=${onOpen} onFull=${onFull} />`;
  const t = thing ?? listed;
  const facts = [
    {label: 'Brand', value: t.brand}, {label: 'Model', value: t.model}, {label: 'Owner', value: t.person?.name ? html`<${EntityLink} kind="person" id=${t.person.id} label=${t.person.name} host=${host} />` : null},
    {label: 'Bought on', value: t.purchaseDate ? dateText(t.purchaseDate) : null}, {label: 'Bought from', value: t.store}, {label: 'Price', value: amountText(t.price)},
    {label: 'Status', value: t.status && t.status !== 'owned' ? fieldLabel(t.status) : null},
    {label: 'Warranty', value: t.warranty ? dateText(t.warranty) : null}, {label: 'Return window', value: t.returnWindow ? dateText(t.returnWindow) : null},
    ...(thing ? thingSpecs(thing).filter(f => !['Brand', 'Model'].includes(f.label)).slice(0, 4) : []),
  ];
  const documents = [...(thing?.documents ?? [])].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return html`<${RecordCard} label=${t.name} facts=${facts} loading=${loading} onOpen=${onFull}
    groups=${[{key: 'documents', title: 'Receipts and documents', items: documents.map(d => ({id: d.id, title: d.title, date: d.date, when: dateText(d.date), glyph: 'document', link: {kind: 'document', id: d.id}, onOpen: () => onOpen?.(d)}))}]}>
    ${thing?.image ? html`<${Thumb} image=${thing.image} host=${host} name=${t.name} />` : null}
    ${loading ? html`<p class="dk-note" role="status">Loading thing…</p>` : null}
  <//>`;
}
/** A thing with its own page (a physical thing: contract/things.md *Hub*) opened in place: its read's summary of that page (what
 *  the list knows, its devices now, its usage and Health lines, its papers); Open › its page. */
function PhysicalCard({id, detail = null, listed, host, onOpen, onFull}) {
  const [model] = useState(() => createPhysicalThing(host));
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => { if (detail?.id === id) model.show(detail); else model.open(id); }, [model, id]);
  useEffect(() => () => model.stop(), [model]);
  const t = model.thing, p = t?.purchase;
  const facts = [
    {label: 'Kind', value: t?.kind ? fieldLabel(t.kind) : null}, {label: 'Room', value: t?.room},
    {label: 'Bought on', value: p?.date ? dateText(p.date) : listed.purchaseDate ? dateText(listed.purchaseDate) : null},
    {label: 'Bought from', value: p?.store ?? listed.store}, {label: 'Price', value: amountText(p?.price ?? listed.price)},
    {label: 'Warranty ends', value: t?.warranty?.expires ? dateText(t.warranty.expires) : null},
  ];
  const away = houseUnavailable(t);
  const live = (t?.devices ?? []).flatMap(d => (d.entities ?? []).map(e => ({label: e.name ?? d.name,
    value: e.state == null ? null : stateText({domain: e.domain ?? String(e.id).split('.')[0], attributes: e.unit ? {unit_of_measurement: e.unit} : {}}, {state: e.state})})));
  const papers = thingPapers(t);
  const lines = away ? ['House unavailable'] : t ? hubLines(t) : [];
  return html`<${RecordCard} label=${t?.name ?? listed.name} facts=${facts} loading=${model.loading} onOpen=${onFull} live=${away ? null : {title: 'Live', facts: live}}
    groups=${[{key: 'papers', title: 'Papers', items: papers.map(d => ({id: d.id, title: d.title, date: d.date, when: d.date ? dateText(d.date) : d.what, glyph: 'document', onOpen: () => onOpen?.(d)}))}]}>
    ${lines.length ? html`<div class="dk-hub-lines">${lines.map(line => html`<p key=${line} class="dk-note">${line}</p>`)}</div>` : null}
    ${model.loading ? html`<p class="dk-note" role="status">Loading thing…</p>` : null}
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} host=${host} inline=${true} retry=${() => model.open(id)} />` : null}
  <//>`;
}
/** The canonical owned-product detail (the whole record: Open), shared with Find's product viewer. */
export function ThingDetail(props) {
  // the viewer's title names it (the thing's own name: collection-reader.js)
  return props.thing?.thingId ? html`<${PhysicalThing} id=${props.thing.thingId} detail=${props.thing.detail ?? null} heading=${false} host=${props.host} onOpen=${props.onOpen} view=${props.view} />`
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
  ].filter(t => t.value != null && t.value !== '');
  const owner = thing.person?.name ? [{label: 'Owner', value: html`<${EntityLink} kind="person" id=${thing.person.id} label=${thing.person.name} host=${host} />`}] : [];
  // only what is known; Things lists owned products, so Owned says nothing
  const terms = [
    {label: 'Status', value: thing.status && thing.status !== 'owned' ? fieldLabel(thing.status) : null},
    {label: 'Warranty', value: thing.warranty ? dateText(thing.warranty) : null},
    {label: 'Return window', value: thing.returnWindow ? dateText(thing.returnWindow) : null},
  ].filter(f => f.value);
  return html`<section class="thing-detail" aria-label="Thing details">
    ${purchase.length ? html`<${StatTiles} label="Purchase" tiles=${purchase} />` : null}
    ${owner.length || terms.length ? html`<${Facts} facts=${[...owner, ...terms]} />` : null}
    ${specs.length ? html`<${Section} title="Specs">
      <${CollectionSearch} page=${specPage} label="Search specifications" />
      <${Facts} facts=${specPage.items} />
      ${!specPage.items.length ? html`<${StateBlock} inline=${true} line="No specifications match" />` : null}
      <${CollectionPager} page=${specPage} label="Specification pages" /><//>` : null}
    ${documents.length ? html`<${Section} title="Receipts and documents">
      <${CollectionSearch} page=${documentPage} label="Search thing documents" />
      <${RowList} inline=${true} items=${documentPage.items.map(d => ({id: d.id, title: d.title, sub: dateText(d.date),
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: documentPage.query ? 'No documents match' : 'No indexed receipts or documents'}} />
      <${CollectionPager} page=${documentPage} label="Thing document pages" /><//>` : null}
    ${thing.image ? html`<${Section} title="Photos"><${Thumb} image=${thing.image} name=${thing.name} host=${host} /><//>` : null}
  </section>`;
}
