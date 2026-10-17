import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createVehicles, paperPhotos, vehicleTiles} from '../vehicles.js';
import {StatTiles} from './stat-tiles.js';
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
    ${src ? html`<img src=${src} alt=${photo.title} loading="lazy" />` : photo.title}
  </button>`;
}

export function Vehicles({model, host, onOpen}) {
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  return html`<main class="dk-vehicles" aria-label="Vehicles" aria-busy=${model.loading}>
    <header><h1>Vehicles</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.loading && !model.error && !model.cars.length ? html`<p>No indexed vehicles</p>` : null}
    ${model.cars.map(({vehicle: v, live, photos, warnings}) => html`<article class="vehicle-card" key=${v.id}>
      <h2>${v.name}</h2><p>${[v.year, v.make, v.model, v.plate].filter(Boolean).join(' · ')}</p>
      ${photos.length ? html`<${Photo} photo=${photos[0]} host=${host} onOpen=${onOpen} hero=${true} /><div class="vehicle-strip">${photos.slice(1).map(p => html`<${Photo} key=${p.id} photo=${p} host=${host} onOpen=${onOpen} />`)}</div>` : html`<p>No indexed photos</p>`}
      ${model.liveAvailable ? html`<${StatTiles} tiles=${vehicleTiles(live)} label=${`${v.name} live state`} />
      ${live.updated ? html`<small>Telemetry updated ${live.updated}</small>` : html`<p>Live state unknown</p>`}
      ${live.location ? html`<button type="button" class="dk-btn" onClick=${() => host.call('url.open', {url: `https://www.openstreetmap.org/?mlat=${live.location.lat}&mlon=${live.location.lon}#map=15/${live.location.lat}/${live.location.lon}`}).catch(() => {})}>📍 ${live.location.lat.toFixed(3)}, ${live.location.lon.toFixed(3)}</button>` : html`<p>Location unknown</p>`}` : null}
      ${warnings.map(w => html`<${Failure} backend=${w.backend} error=${w} retry=${() => model.refresh()} host=${host} />`)}
      <h3>Papers</h3>
      ${(v.papers ?? []).map((p, i) => html`<section key=${`${p.document?.id}:${i}`}><button type="button" class="dk-btn" onClick=${() => onOpen(p.document)}>${p.document?.title ?? p.kind}${p.expiry ? ` · expires ${p.expiry}` : ''}</button>
        ${paperPhotos(p, photos).length ? html`<small>Photos on the same date</small>` : null}
        ${paperPhotos(p, photos).map(photo => html`<${Photo} key=${photo.id} photo=${photo} host=${host} onOpen=${onOpen} />`)}
      </section>`)}
      ${(v.expiring ?? []).map(p => html`<p class="vehicle-expiry">${p.kind}: ${p.state} ${p.expiry}</p>`)}
      ${v.missing?.length ? html`<p>Not indexed: ${v.missing.join(', ')}</p>` : null}
    </article>`)}
  </main>`;
}

export function VehiclesPlace({host, onOpen, mapping}) {
  const [model] = useState(() => createVehicles(host, {mapping}));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Vehicles} model=${model} host=${host} onOpen=${onOpen} />`;
}
