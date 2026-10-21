import {PageHeader} from './page-header.js';
import {CollectionSearch, CollectionPager, collectionText, useCollectionPage} from './collection-page.js';
import {DetailList} from './detail-list.js';
import {Failure} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {expiryText, paperPhotos, vehicleExpiries, vehicleTiles} from '../vehicles.js';
import {countText, dateText, dateTimeText, fieldLabel, heldPapers, joinText, plural} from '../format.js';
import {StatTiles} from './stat-tiles.js';
import {Facts, SectionHead} from './drawer.js';
import {RecordCard} from './record-card.js';
import {EntityLink} from './entity-link.js';
import {RowList} from './rows.js';
import {usePageSelection} from './page-selection.js';
import {resourcePath} from '../host/host.js';
import {PhotoStrip} from './photo-strip.js';
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

/** What Habitat reports for a car, nothing for what it does not: `figures` (charge, fuel, range tiles with a value) and `facts` (locks,
 *  doors, climate, charging, its place as a map link), `updated` when. An EV has no fuel figure; an unreported door state is left out. */
export function vehicleLive(car, host) {
  const {vehicle: v, live = {}} = car;
  const tiles = vehicleTiles(live), figures = tiles.slice(0, 3).filter(t => t.quantity?.value != null);
  const facts = tiles.slice(3).filter(t => t.value !== 'Unknown').map(t => ({label: t.label, value: t.value}));
  const at = live.location, place = at ? `${at.lat.toFixed(3)}, ${at.lon.toFixed(3)}` : null;
  if (at) facts.push({label: 'Location', value: html`<button type="button" class="dk-btn text vehicle-location" title=${place}
    aria-label=${`Open location ${at.zone ? fieldLabel(at.zone) : place} on a map`} onClick=${ev => { ev.stopPropagation(); host.call('url.open', {url: `https://www.openstreetmap.org/?mlat=${at.lat}&mlon=${at.lon}#map=15/${at.lat}/${at.lon}`}).catch(() => {}); }}>${at.zone ? fieldLabel(at.zone) : 'On the map'} ↗</button>`});
  const updated = live.updated && (figures.length || facts.length) ? html`<time datetime=${live.updated} title=${live.updated}>Updated ${dateTimeText(live.updated, {now: new Date()})}</time>` : null;
  return {figures, facts, updated, label: `${v.name} live state`};
}
// renewals bridge reports without an indexed paper of the same expiry
const looseRenewals = v => (v.expiring ?? []).filter(e => !(v.papers ?? []).some(p => p.kind === e.kind && p.expiry === e.expiry));
const paperItems = (v, photos = []) => (v.papers ?? []).map((p, i) => {
  const renewal = (v.expiring ?? []).find(e => e.kind === p.kind && e.expiry === p.expiry), same = paperPhotos(p, photos).length;
  return {id: `${p.document?.id}:${i}`, title: p.document?.title ?? fieldLabel(p.kind), date: p.document?.date, paper: p,
    sub: joinText([fieldLabel(p.kind), p.expiry ? expiryText(p.expiry, renewal?.state) : null, same ? plural(same, 'photo') + ' that day' : null]),
    badge: renewal?.state === 'expired' ? {text: 'Expired', tone: 'bad'} : renewal?.state === 'expiring' ? {text: 'Expiring', tone: 'warn'} : null};
});

/** A person bridge names on a car (owner, driver): their name, linking to them when bridge gives their id. */
const personValue = (p, host) => p?.name ? html`<${EntityLink} kind="person" id=${p.id} label=${p.name} host=${host} />` : null;
/** A car opened in place (the shared record card): what it is, its renewals, live state when Habitat reports any, its newest papers;
 *  Open the whole record (`onFull`). */
export function VehicleCard({car, host, onOpen, onFull}) {
  const v = car.vehicle, live = vehicleLive(car, host);
  const facts = [
    {label: 'Year', value: v.year}, {label: 'Make', value: v.make}, {label: 'Model', value: v.model}, {label: 'Plate', value: v.plate},
    {label: 'Owner', value: personValue(v.owner, host)}, {label: 'Driver', value: personValue(v.driver, host)},
    ...vehicleExpiries(v).filter(p => p.expiry).map(p => ({label: fieldLabel(p.kind), value: expiryText(p.expiry, p.state)})),
  ];
  const papers = [...paperItems(v)].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .map(r => ({id: r.id, title: r.title, date: r.date, when: dateText(r.date), glyph: 'document', link: r.paper.document ? {kind: 'document', id: r.paper.document.id} : null,
      onOpen: () => r.paper.document && onOpen?.(r.paper.document)}));
  const photos = (car.photos ?? []).filter(p => p.thumb);
  return html`<${RecordCard} label=${v.name} facts=${facts}
    live=${{title: 'Live', label: live.label, meta: live.updated, tiles: live.figures, tilesLabel: `${v.name} charge, fuel and range`, facts: live.facts}}
    groups=${[{key: 'papers', title: 'Papers', items: papers}]} onOpen=${onFull}>
    ${photos.length ? html`<${PhotoStrip} items=${photos.map(p => ({id: String(p.id), path: p.thumb, label: `Open ${p.title}`}))} host=${host} label=${`${v.name} photos`}
      onOpen=${i => onOpen?.(photos[i])} onAll=${onFull ?? undefined} />` : null}
  <//>`;
}

/** Canonical vehicle papers, telemetry and photos: the whole record (Open), Find's desktop pane. Only what is known: no live state
 *  until Habitat reports some, no photos column without photos. */
export function VehicleDetail({car, model, host, onOpen, id, view}) {
  const {vehicle: v, photos = [], photosLoading = false, warnings = []} = car;
  const photoPage = useCollectionPage(photos, {size: 20, resetKey: v.id, view, key: `vehicle-photos:${v.id}`});
  const live = vehicleLive(car, host), renewals = looseRenewals(v), pictured = photosLoading || photos.length > 0;
  const people = [{label: 'Owner', value: personValue(v.owner, host)}, {label: 'Driver', value: personValue(v.driver, host)}].filter(f => f.value);
  return html`<div class=${`vehicle-details${pictured ? ' pictured' : ''}`} id=${id}>
      <div class="vehicle-primary">
        ${people.length ? html`<${Facts} facts=${people} />` : null}
        ${model.liveAvailable && (live.figures.length || live.facts.length) ? html`<section class="dk-section vehicle-live" aria-label=${live.label}><${SectionHead} level=${3} title="Live state" meta=${live.updated} />
          ${live.figures.length ? html`<${StatTiles} compact tiles=${live.figures} label=${`${v.name} charge, fuel and range`} />` : null}
          ${live.facts.length ? html`<${Facts} facts=${live.facts} />` : null}
        </section>` : null}
        ${warnings.map(w => html`<${Failure} backend=${w.backend} error=${w} retry=${() => model.refresh()} host=${host} />`)}
        <${DetailList} title="Papers" view=${view} listKey=${`vehicle-papers:${v.id}`} resetKey=${v.id} onOpen=${r => r.paper.document && onOpen(r.paper.document)}
          note=${v.missing?.length ? `Not indexed: ${v.missing.map(fieldLabel).join(', ')}` : null} items=${paperItems(v, photos)} />
        ${renewals.length ? html`<section class="dk-section" aria-label="Renewals"><${SectionHead} level=${3} title="Renewals" />
          <${Facts} facts=${renewals.map(e => ({label: fieldLabel(e.kind), value: expiryText(e.expiry, e.state)}))} /></section>` : null}
      </div>
      ${pictured ? html`<section class="dk-section vehicle-photos" aria-label=${`${v.name} photos`}><${SectionHead} level=${3} title="Photos" meta=${photos.length ? countText(photos.length) : null} />
        ${photosLoading ? html`<div class="vehicle-photos-loading" role="status" aria-label="Loading photos"><span class="vehicle-photo hero dk-ph"></span>
            <div class="vehicle-strip">${[0, 1, 2].map(i => html`<span key=${i} class="vehicle-photo dk-ph"></span>`)}</div></div>`
          : html`<${Photo} key=${photoPage.items[0].id} photo=${photoPage.items[0]} host=${host} onOpen=${onOpen} hero=${true} />
          ${photoPage.items.length > 1 ? html`<div class="vehicle-strip">${photoPage.items.slice(1).map(p => html`<${Photo} key=${p.id} photo=${p} host=${host} onOpen=${onOpen} />`)}</div>` : null}`}
        <${CollectionPager} page=${photoPage} label=${`${v.name} photo pages`} />
      </section>` : null}
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
  const page = useCollectionPage(model.cars, {size: 40, textOf: carText, view, key: 'list'});
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  // photos only for the car opened in place
  useEffect(() => { model.showPhotos(selected && model.cars.some(c => c.vehicle.id === selected) ? [selected] : []); }, [model, model.cars, selected]);
  useEffect(() => () => { model.showPhotos([]); }, [model]);
  return html`<main class="dk-vehicles dk-page" aria-label="Vehicles" aria-busy=${model.loading}>
    <${PageHeader} title="Vehicles" description="Papers, photos and observed vehicle state." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${page} label="Search vehicles" />
    <${RowList} card=${true} loading=${model.loading && !model.cars.length ? 3 : 0} empty=${page.query ? {title: 'No vehicles match', line: 'Try another name, make or plate.', glyph: 'find'} : {title: 'No vehicles yet', line: 'Cars show here with their registration, insurance and service papers once they are indexed.', glyph: 'car'}} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${page.items.map(({vehicle: v}) => ({id: v.id, title: v.name, glyph: 'car',
      sub: vehicleSubtitle(v),
      // a renewal with its date; the kinds not indexed are the whole record's (Open)
      notes: vehicleExpiries(v).filter(p => p.expiry).map(p => ({text: `${fieldLabel(p.kind)}: ${expiryText(p.expiry, p.state)}`, tone: p.state === 'expired' ? 'bad' : p.state === 'expiring' ? 'warn' : ''})),
      // what it holds, one quiet line
      summary: heldPapers(v.papers ?? [])}))}
      current=${selected} onOpen=${(r, {page} = {}) => page && navigation ? navigation.openRecord(r.id) : select(r.id)} onClose=${() => select(null)}
      expand=${r => { const it = model.cars.find(c => c.vehicle.id === r.id); return it ? html`<${VehicleCard} key=${r.id} car=${it} host=${host} onOpen=${onOpen}
        onFull=${navigation ? () => navigation.openRecord(r.id) : null} />` : null; }} />
    <${CollectionPager} page=${page} label="Vehicle pages" />
  </main>`;
}

