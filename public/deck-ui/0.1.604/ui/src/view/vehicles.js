import {CollectionSearch, CollectionPager, collectionText, useCollectionPage} from './collection-page.js';
import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useId, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createVehicles, paperPhotos, vehicleTiles} from '../vehicles.js';
import {dateText, dateTimeText} from '../quantity.js';
import {StatTiles} from './stat-tiles.js';
import {Facts} from './drawer.js';
import {Glyph} from '../glyphs.js';
import {resourcePath} from '../host/host.js';
const html = htm.bind(h);
const paperDate = at => dateText(at, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});

function Photo({photo, host, onOpen, hero = false}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    const path = resourcePath(photo.thumb);
    if (path) Promise.resolve(host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [photo.id, photo.thumb, host]);
  return html`<button type="button" class=${`dk-btn vehicle-photo${hero ? ' hero' : ''}`} onClick=${() => onOpen(photo)} aria-label=${`Open ${photo.title}`}>
    ${src ? html`<img src=${src} alt=${photo.title} loading="lazy" decoding="async" />` : html`<span>${photo.title}</span>`}
  </button>`;
}

const carText = ({vehicle}) => [collectionText(vehicle), vehicle.plate, vehicle.vin].filter(Boolean).join(' ');
const paperText = paper => `${collectionText(paper)} ${collectionText(paper.document)}`;

function PaperPhotoStrip({paper, photos, host, onOpen, view}) {
  const page = useCollectionPage(paperPhotos(paper, photos), {size: 20, resetKey: paper.document?.id, view, key: `vehicle-paper-photos:${paper.document?.id}`});
  if (!page.total) return null;
  return html`<div class="vehicle-paper-photos"><span>Photos on the same date</span><div class="vehicle-strip">${page.items.map(photo => html`<${Photo} key=${photo.id} photo=${photo} host=${host} onOpen=${onOpen} />`)}</div>
    <${CollectionPager} page=${page} label=${`${paper.document?.title ?? paper.kind} photo pages`} /></div>`;
}

function VehicleCard({car, model, host, onOpen, id, expanded, onExpand, view}) {
  const {vehicle: v} = car, papers = v.papers ?? [], detailId = `${id}-${encodeURIComponent(v.id)}`;
  return html`<article class="vehicle-card" key=${v.id}>
    <header class="vehicle-card-head"><div class="vehicle-identity"><h2>${v.name}</h2><p>${[v.year, v.make, v.model, v.plate].filter(Boolean).join(' · ')}</p>
      <span class="vehicle-paper-count">${papers.length} ${papers.length === 1 ? 'paper' : 'papers'} indexed</span></div>
      <button type="button" class="dk-btn vehicle-expand" aria-expanded=${expanded} aria-controls=${detailId} aria-label=${`${expanded ? 'Collapse' : 'Expand'} ${v.name}`} onClick=${onExpand}>${expanded ? 'Collapse' : 'Expand'}<${Glyph} name="next" size=${14} /></button>
    </header>
    ${expanded ? html`<${VehicleDetail} car=${car} model=${model} host=${host} onOpen=${onOpen} id=${detailId} view=${view} />` : null}
  </article>`;
}

/** Canonical vehicle papers, telemetry and photos for collection cards and Find. */
export function VehicleDetail({car, model, host, onOpen, id, view}) {
  const {vehicle: v, live = {}, photos = [], photosLoading = false, warnings = []} = car;
  const paperPage = useCollectionPage(v.papers ?? [], {size: 20, textOf: paperText, resetKey: v.id, view, key: `vehicle-papers:${v.id}`});
  const photoPage = useCollectionPage(photos, {size: 20, resetKey: v.id, view, key: `vehicle-photos:${v.id}`});
  const expiryPage = useCollectionPage(v.expiring ?? [], {size: 20, resetKey: v.id, view, key: `vehicle-expiries:${v.id}`});
  const tiles = vehicleTiles(live), papers = v.papers ?? [];
  return html`<div class="vehicle-details" id=${id}>
      <div class="vehicle-primary">
        ${model.liveAvailable ? html`<div class="vehicle-live" role="group" aria-label=${`${v.name} live state`}><div class="vehicle-section-head"><h3>Live state</h3>
          ${live.updated ? html`<time datetime=${live.updated} title=${live.updated}>Telemetry updated ${dateTimeText(live.updated)}</time>` : html`<span>Live state unknown</span>`}</div>
          <${StatTiles} tiles=${tiles.slice(0, 3)} label=${`${v.name} charge, fuel and range`} />
          <${Facts} facts=${tiles.slice(3).map(t => ({label: t.label, value: t.value}))} />
          <div class="vehicle-location">${live.location ? html`<button type="button" class="dk-btn" onClick=${() => host.call('url.open', {url: `https://www.openstreetmap.org/?mlat=${live.location.lat}&mlon=${live.location.lon}#map=15/${live.location.lat}/${live.location.lon}`}).catch(() => {})}><${Glyph} name="map" size=${14} />Open location<span>${live.location.lat.toFixed(3)}, ${live.location.lon.toFixed(3)}</span></button>` : html`<span>Location unknown</span>`}</div>
        </div>` : null}
        ${warnings.map(w => html`<${Failure} backend=${w.backend} error=${w} retry=${() => model.refresh()} host=${host} />`)}
        <section class="vehicle-papers" aria-label=${`${v.name} papers`}><div class="vehicle-section-head"><h3>Papers</h3><span>${papers.length} indexed</span></div>
          <${CollectionSearch} page=${paperPage} label=${`Search ${v.name} papers`} />
          <div class="vehicle-paper-list">${paperPage.items.map((p, i) => {
            const title = p.document?.title ?? p.kind;
            return html`<div class="vehicle-paper" key=${`${p.document?.id}:${i}`}>
              <button type="button" class="dk-btn vehicle-paper-title" aria-label=${`${title}${p.expiry ? ` · expires ${p.expiry}` : ''}`} onClick=${() => onOpen(p.document)}><span>${title}</span><${Glyph} name="next" size=${14} /></button>
              <div class="vehicle-paper-meta"><span>${p.kind}</span>${p.expiry ? html`<time datetime=${p.expiry}>Expires ${paperDate(p.expiry)}</time>` : null}</div>
              <${PaperPhotoStrip} paper=${p} photos=${photos} host=${host} onOpen=${onOpen} view=${view} />
            </div>`;
          })}</div>
          <${CollectionPager} page=${paperPage} label=${`${v.name} paper pages`} />
          ${!papers.length ? html`<p class="vehicle-note">No indexed papers</p>` : null}
          ${expiryPage.items.map(p => html`<p class="vehicle-expiry">${p.kind}: ${p.state} ${paperDate(p.expiry)}</p>`)}
          <${CollectionPager} page=${expiryPage} label=${`${v.name} renewal pages`} />
          ${v.missing?.length ? html`<p class="vehicle-note">Not indexed: ${v.missing.join(', ')}</p>` : null}
        </section>
      </div>
      <aside class="vehicle-photos" aria-label=${`${v.name} photos`}><div class="vehicle-section-head"><h3>Photos</h3>${photos.length ? html`<span>${photos.length} indexed</span>` : null}</div>
        <${CollectionSearch} page=${photoPage} label=${`Search ${v.name} photos`} loading=${photosLoading} />
        ${photosLoading ? html`<p class="vehicle-note" role="status">Loading photos…</p>` : null}
        ${photoPage.items.length ? html`<${Photo} key=${photoPage.items[0].id} photo=${photoPage.items[0]} host=${host} onOpen=${onOpen} hero=${true} />
          ${photoPage.items.length > 1 ? html`<div class="vehicle-strip">${photoPage.items.slice(1).map(p => html`<${Photo} key=${p.id} photo=${p} host=${host} onOpen=${onOpen} />`)}</div>` : null}` : !photosLoading ? html`<p class="vehicle-note">${photos.length ? 'No photos match' : 'No indexed photos'}</p>` : null}
        <${CollectionPager} page=${photoPage} label=${`${v.name} photo pages`} />
      </aside>
  </div>`;
}

export function Vehicles({model, host, onOpen, view}) {
  const [, redraw] = useState(0), id = useId();
  const [localView] = useState({});
  view ??= localView;
  const [expanded, updateExpanded] = useState(() => view.expanded ?? {});
  const setExpanded = action => updateExpanded(previous => { const next = typeof action === 'function' ? action(previous) : action; view.expanded = next; return next; });
  const page = useCollectionPage(model.cars, {size: 40, textOf: carText, view, key: 'list'});
  const visibleExpanded = JSON.stringify(page.items.filter(car => expanded[car.vehicle.id]).map(car => car.vehicle.id));
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => { model.showPhotos(JSON.parse(visibleExpanded)); }, [model, model.cars, visibleExpanded]);
  useEffect(() => () => { model.showPhotos([]); }, [model]);
  return html`<main class="dk-vehicles" aria-label="Vehicles" aria-busy=${model.loading}>
    <header class="vehicle-page-head"><div><h1>Vehicles</h1><p>Papers, photos and observed vehicle state.</p></div>
      <button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    <${CollectionSearch} page=${page} label="Search vehicles" loading=${model.loading} error=${model.error} />
    ${model.warming ? html`<p role="status">Bridge is starting, updating…</p>` : null}
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.loading && !model.error && !model.cars.length ? html`<p class="vehicle-empty">No indexed vehicles</p>` : null}
    ${page.items.map(car => html`<${VehicleCard} key=${car.vehicle.id} car=${car} model=${model} host=${host} onOpen=${onOpen} id=${id} expanded=${!!expanded[car.vehicle.id]} view=${view}
      onExpand=${() => setExpanded(current => ({...current, [car.vehicle.id]: !current[car.vehicle.id]}))} />`)}
    <${CollectionPager} page=${page} label="Vehicle pages" />
  </main>`;
}

export function VehiclesPlace({host, onOpen, mapping, view}) {
  const [model] = useState(() => createVehicles(host, {mapping}));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Vehicles} model=${model} host=${host} onOpen=${onOpen} view=${view} />`;
}
