import {PageHeader} from './page-header.js';
import {CollectionSearch, CollectionPager, collectionText, useCollectionPage} from './collection-page.js';
import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createVehicles, paperPhotos, vehicleExpiries, vehicleTiles} from '../vehicles.js';
import {dateText, dateTimeText} from '../quantity.js';
import {StatTiles} from './stat-tiles.js';
import {Drawer, Facts} from './drawer.js';
import {RowList} from './rows.js';
import {usePageSelection} from './page-selection.js';
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

export function Vehicles({model, host, onOpen, view, navigation}) {
  const [, redraw] = useState(0);
  const [localView] = useState({});
  view ??= localView;
  const [localSelected, setSelected] = useState(() => view.selected ?? null);
  const [routeSelected, selectRoute] = usePageSelection(navigation);
  const selected = navigation ? routeSelected : localSelected;
  const select = id => { view.selected = id; if (navigation) selectRoute(id); else setSelected(id); };
  const car = model.cars.find(car => car.vehicle.id === selected);
  const page = useCollectionPage(model.cars, {size: 40, textOf: carText, view, key: 'list'});
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => { model.showPhotos(car ? [car.vehicle.id] : []); }, [model, model.cars, selected]);
  useEffect(() => () => { model.showPhotos([]); }, [model]);
  return html`<main class="dk-vehicles dk-page" aria-label="Vehicles" aria-busy=${model.loading}>
    <${PageHeader} title="Vehicles" description="Papers, photos and observed vehicle state." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${page} label="Search vehicles" loading=${model.loading} error=${model.error} />
    <${RowList} loading=${model.loading && !model.cars.length ? 3 : 0} empty=${{title: page.query ? 'No vehicles match' : 'No indexed vehicles'}} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${page.items.map(({vehicle: v}) => ({id: v.id, title: v.name, glyph: 'car',
      sub: [v.year, v.make, v.model, v.plate].filter(Boolean).join(' · '),
      notes: vehicleExpiries(v).map(p => ({text: `${p.kind === 'registration' ? 'Registration' : 'Inspection'}: ${p.expiry ? `${p.state === 'expired' ? 'Expired' : p.state === 'expiring' ? 'Expiring' : 'Expires'} ${paperDate(p.expiry)}` : p.state === 'missing' ? 'Not indexed' : 'Expiry unknown'}`, tone: p.state === 'expired' ? 'bad' : p.state === 'expiring' ? 'warn' : ''})),
      summary: `${(v.papers ?? []).length} papers indexed`}))} current=${selected} onOpen=${r => select(r.id)} />
    <${Drawer} open=${!!car} title=${car?.vehicle.name} onClose=${() => select(null)}>
      ${car ? html`<${VehicleDetail} key=${car.vehicle.id} car=${car} model=${model} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
    <${CollectionPager} page=${page} label="Vehicle pages" />
  </main>`;
}

export function VehiclesPlace({host, onOpen, mapping, view, navigation}) {
  const [model] = useState(() => createVehicles(host, {mapping}));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Vehicles} model=${model} host=${host} onOpen=${onOpen} view=${view} navigation=${navigation} />`;
}
