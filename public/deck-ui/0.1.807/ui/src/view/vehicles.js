import {PageHeader} from './page-header.js';
import {CollectionSearch, CollectionPager, collectionText, useCollectionPage} from './collection-page.js';
import {DetailList} from './detail-list.js';
import {Failure} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {expiryText, paperPhotos, vehicleExpiries, vehicleTiles} from '../vehicles.js';
import {countText, dateTimeText, fieldLabel, joinText, plural} from '../format.js';
import {StatTiles} from './stat-tiles.js';
import {Drawer, Facts, SectionHead} from './drawer.js';
import {RowList} from './rows.js';
import {usePageSelection} from './page-selection.js';
import {resourcePath} from '../host/host.js';
const html = htm.bind(h);

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

const titleWords = value => ` ${String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const vehicleSubtitle = v => [v.year, v.make, v.model, v.plate].filter(value => value && !titleWords(v.name).includes(titleWords(value))).join(' · ');

const carText = ({vehicle}) => [collectionText(vehicle), vehicle.plate, vehicle.vin].filter(Boolean).join(' ');

/** Canonical vehicle papers, telemetry and photos for collection cards and Find. */
export function VehicleDetail({car, model, host, onOpen, id, view}) {
  const {vehicle: v, live = {}, photos = [], photosLoading = false, warnings = []} = car;
  const photoPage = useCollectionPage(photos, {size: 20, resetKey: v.id, view, key: `vehicle-photos:${v.id}`});
  const papers = v.papers ?? [];
  // only what Habitat reports: an EV has no fuel figure, an unreported door state is left out
  const tiles = vehicleTiles(live), figures = tiles.slice(0, 3).filter(t => t.quantity?.value != null);
  const facts = tiles.slice(3).filter(t => t.value !== 'Unknown').map(t => ({label: t.label, value: t.value}));
  const at = live.location, place = at ? `${at.lat.toFixed(3)}, ${at.lon.toFixed(3)}` : null;
  if (at) facts.push({label: 'Location', value: html`<button type="button" class="dk-btn text vehicle-location" title=${place}
    aria-label=${`Open location ${at.zone ? fieldLabel(at.zone) : place} on a map`} onClick=${() => host.call('url.open', {url: `https://www.openstreetmap.org/?mlat=${at.lat}&mlon=${at.lon}#map=15/${at.lat}/${at.lon}`}).catch(() => {})}>${at.zone ? fieldLabel(at.zone) : 'On the map'} ↗</button>`});
  // renewals bridge reports without an indexed paper of the same expiry
  const renewals = (v.expiring ?? []).filter(e => !papers.some(p => p.kind === e.kind && p.expiry === e.expiry));
  return html`<div class="vehicle-details" id=${id}>
      <div class="vehicle-primary">
        ${model.liveAvailable ? html`<section class="dk-section vehicle-live" aria-label=${`${v.name} live state`}><${SectionHead} level=${3} title="Live state"
            meta=${live.updated ? html`<time datetime=${live.updated} title=${live.updated}>Updated ${dateTimeText(live.updated, {now: new Date()})}</time>` : null} />
          ${figures.length ? html`<${StatTiles} compact tiles=${figures} label=${`${v.name} charge, fuel and range`} />` : null}
          ${facts.length ? html`<${Facts} facts=${facts} />` : html`<p class="dk-note">Nothing reported yet</p>`}
        </section>` : null}
        ${warnings.map(w => html`<${Failure} backend=${w.backend} error=${w} retry=${() => model.refresh()} host=${host} />`)}
        <${DetailList} title="Papers" view=${view} listKey=${`vehicle-papers:${v.id}`} resetKey=${v.id} onOpen=${r => r.paper.document && onOpen(r.paper.document)}
          note=${v.missing?.length ? `Not indexed: ${v.missing.map(fieldLabel).join(', ')}` : null} empty="No indexed papers"
          items=${papers.map((p, i) => {
            const renewal = (v.expiring ?? []).find(e => e.kind === p.kind && e.expiry === p.expiry), same = paperPhotos(p, photos).length;
            return {id: `${p.document?.id}:${i}`, title: p.document?.title ?? fieldLabel(p.kind), date: p.document?.date, paper: p,
              sub: joinText([fieldLabel(p.kind), p.expiry ? expiryText(p.expiry, renewal?.state) : null, same ? plural(same, 'photo') + ' that day' : null]),
              badge: renewal?.state === 'expired' ? {text: 'Expired', tone: 'bad'} : renewal?.state === 'expiring' ? {text: 'Expiring', tone: 'warn'} : null};
          })} />
        ${renewals.length ? html`<section class="dk-section" aria-label="Renewals"><${SectionHead} level=${3} title="Renewals" />
          <${Facts} facts=${renewals.map(e => ({label: fieldLabel(e.kind), value: expiryText(e.expiry, e.state)}))} /></section>` : null}
      </div>
      <section class="dk-section vehicle-photos" aria-label=${`${v.name} photos`}><${SectionHead} level=${3} title="Photos" meta=${photos.length ? countText(photos.length) : null} />
        ${photosLoading ? html`<div class="vehicle-photos-loading" role="status" aria-label="Loading photos"><span class="vehicle-photo hero dk-ph"></span>
            <div class="vehicle-strip">${[0, 1, 2].map(i => html`<span key=${i} class="vehicle-photo dk-ph"></span>`)}</div></div>`
          : photoPage.items.length ? html`<${Photo} key=${photoPage.items[0].id} photo=${photoPage.items[0]} host=${host} onOpen=${onOpen} hero=${true} />
          ${photoPage.items.length > 1 ? html`<div class="vehicle-strip">${photoPage.items.slice(1).map(p => html`<${Photo} key=${p.id} photo=${p} host=${host} onOpen=${onOpen} />`)}</div>` : null}`
          : html`<p class="dk-note">No indexed photos</p>`}
        <${CollectionPager} page=${photoPage} label=${`${v.name} photo pages`} />
      </section>
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
    <${CollectionSearch} page=${page} label="Search vehicles" />
    <${RowList} card=${true} loading=${model.loading && !model.cars.length ? 3 : 0} empty=${page.query ? {title: 'No vehicles match', line: 'Try another name, make or plate.', glyph: 'find'} : {title: 'No vehicles yet', line: 'Cars show here with their registration, insurance and service papers once they are indexed.', glyph: 'car'}} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${page.items.map(({vehicle: v}) => ({id: v.id, title: v.name, glyph: 'car',
      sub: vehicleSubtitle(v),
      // a renewal with its date; one the papers say nothing about is left to the summary
      notes: vehicleExpiries(v).filter(p => p.expiry).map(p => ({text: `${fieldLabel(p.kind)}: ${expiryText(p.expiry, p.state)}`, tone: p.state === 'expired' ? 'bad' : p.state === 'expiring' ? 'warn' : ''})),
      summary: joinText([plural((v.papers ?? []).length, 'paper'), v.missing?.length ? `no ${v.missing.map(k => fieldLabel(k).toLowerCase()).join(' or ')} indexed` : null])}))} current=${selected} onOpen=${r => select(r.id)} />
    <${Drawer} open=${!!car} title=${car?.vehicle.name} onClose=${() => select(null)}>
      ${car ? html`<${VehicleDetail} key=${car.vehicle.id} car=${car} model=${model} host=${host} onOpen=${onOpen} view=${view} />` : null}
    <//>
    <${CollectionPager} page=${page} label="Vehicle pages" />
  </main>`;
}

