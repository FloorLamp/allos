// The map (contract/media.md *Map*): Leaflet (view/leaflet.js: pinned on cdnjs, its sha384 checked) on OpenStreetMap's tiles, in three
// modes: a route (a trip's points as a line, start and end pins, a time slider), points (a pin each) and an area (a place's pin and
// Habitat's zones near it as labelled circles). Only tile requests leave the page: places come with their coordinates, nothing is
// geocoded or searched. Under it the summary and a list (or a hidden table) of the same places, which stay when the map cannot load.
// `baseMap` and `pinIcon` are the map every Deck page draws on (the wall's delivery map too).
import {h, render} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {DateTimeFormatter, dateTimeText, joinText} from '../format.js';
import {pageMember} from '../host/member.js';
import {isPlace, mapSummary, metresText, thinRoute, zonesNear} from '../geo.js';
import {shiftDateStr, zonedWallTimeToUtc} from '../zoned.js';
import {LEAFLET, loadLeaflet} from './leaflet.js';
import {Failure, Skeleton} from './page-state.js';

const html = htm.bind(h);
const PAD = 44, MAX_ZOOM = 16;

/** A Leaflet map in `el` on OpenStreetMap's tiles. `kiosk` (the wall): no gestures at all; otherwise drag (not on a phone, where one
 *  finger scrolls the page), pinch and double-click zoom, never the wheel (the page scrolls). Leaflet's own controls set markup from
 *  strings, so pages draw their own. */
export function baseMap(L, el, {kiosk = false} = {}) {
  const still = !!el.ownerDocument.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const map = L.map(el, {zoomControl: false, attributionControl: false, zoomSnap: 0.5, scrollWheelZoom: false, boxZoom: false,
    dragging: !kiosk && !L.Browser.mobile, touchZoom: !kiosk, doubleClickZoom: !kiosk, keyboard: !kiosk, tap: false,
    zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still});
  L.tileLayer(LEAFLET.tiles, {maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin'}).addTo(map);
  map.still = still;
  return map;
}
/** A round pin with a glyph (Leaflet's divIcon takes an element, never markup): `kind` its class (`home`, `dasher`, `start`, `end`,
 *  `place`). */
export function pinIcon(L, doc, kind, glyph, {size = 40, label = null} = {}) {
  const holder = doc.createElement('div');
  render(html`<span class=${`dm-pin ${kind}`} data-pin=${kind}>${h(Glyph, {name: glyph, size: Math.round(size * 0.55)})}${label ? html`<span class="dk-sr">${label}</span>` : null}</span>`, holder);
  return L.divIcon({html: holder.firstChild, className: 'dm-marker', iconSize: [size, size], iconAnchor: [size / 2, size / 2]});
}

/** What the map draws for each mode, onto `map` (no React state: Leaflet's layers); `{fit(), cursor(i)}`. */
function drawMode(L, map, el, {mode, route, points, area}) {
  const doc = el.ownerDocument, group = L.featureGroup().addTo(map), bounds = [];
  let cursor = null, pts = [];
  if (mode === 'route') {
    pts = thinRoute(route?.points);
    if (pts.length) {
      const line = pts.map(p => [p.lat, p.lon]);
      L.polyline(line, {className: 'dm-route', interactive: false}).addTo(group);
      L.marker(line[0], {icon: pinIcon(L, doc, 'start', 'place', {size: 32, label: 'Start'}), keyboard: false, interactive: false}).addTo(group);
      L.marker(line.at(-1), {icon: pinIcon(L, doc, 'end', 'place', {size: 32, label: 'End'}), keyboard: false, interactive: false}).addTo(group);
      bounds.push(...line);
    }
  } else if (mode === 'points') {
    for (const p of (points ?? []).filter(isPlace)) {
      const m = L.marker([p.lat, p.lon], {icon: pinIcon(L, doc, p.kind ?? 'place', p.glyph ?? 'place', {size: 34, label: p.label}), title: p.label ?? '', keyboard: false,
        interactive: !!p.onOpen}).addTo(group);
      if (p.onOpen) m.on('click', () => p.onOpen());
      bounds.push([p.lat, p.lon]);
    }
  } else if (mode === 'area' && isPlace(area?.center)) {
    const c = area.center, near = zonesNear(c, area.zones, area.within_m ?? 5000);
    for (const z of near) {
      const label = doc.createElement('span');
      label.textContent = z.name;
      const circle = L.circle([z.at.lat, z.at.lon], {radius: z.radius_m || 1, className: 'dm-zone', interactive: false}).addTo(group);
      // on its side away from the place's pin (under the pin when it holds it), so no name covers the pin
      const dy = z.at.lat - c.lat, dx = (z.at.lon - c.lon) * Math.cos(c.lat * Math.PI / 180);
      const side = z.inside ? 'bottom' : Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 'top' : 'bottom') : (dx > 0 ? 'right' : 'left');
      const offset = {top: [0, -8], bottom: [0, z.inside ? 20 : 8], left: [-8, 0], right: [8, 0]}[side];
      circle.bindTooltip(label, {permanent: true, direction: side, offset, className: 'dm-label', opacity: 1});
      const r = Math.max(z.radius_m, 1) / 111320;
      bounds.push([z.at.lat - r, z.at.lon - r / Math.cos(z.at.lat * Math.PI / 180)], [z.at.lat + r, z.at.lon + r / Math.cos(z.at.lat * Math.PI / 180)]);
    }
    L.marker([c.lat, c.lon], {icon: pinIcon(L, doc, 'home', 'house', {size: 36, label: c.label}), keyboard: false, interactive: false, zIndexOffset: 1000}).addTo(group);
    bounds.push([c.lat, c.lon]);
    el.dataset.zones = near.map(z => z.id).join(',');
  }
  const fit = () => {
    if (!bounds.length) return map.setView([20, 0], 2);
    if (bounds.length === 1) return map.setView(bounds[0], 15, {animate: false});
    return map.fitBounds(L.latLngBounds(bounds), {padding: [PAD, PAD], maxZoom: MAX_ZOOM, animate: false});
  };
  fit();
  // the slider's marker, from its first move (until then the end pin says where the route ends)
  const place = i => {
    if (!pts[i]) return;
    cursor ??= L.circleMarker([pts[i].lat, pts[i].lon], {radius: 7, className: 'dm-cursor', interactive: false}).addTo(group);
    cursor.setLatLng([pts[i].lat, pts[i].lon]);
  };
  return {fit, remove: () => group.remove(), cursor: place, pts};
}

/** mode: 'route' | 'points' | 'area'; route {points: [{lat, lon, time}]}; points [{id, lat, lon, label, glyph?, kind?, time?, onOpen?}];
 *  area {center: {lat, lon, label}, zones, within_m?}; kiosk: no controls, gestures or list; note: a line under the summary. */
export function MapView({mode = 'points', label = 'Map', route = null, points = null, area = null, kiosk = false, timeZone, now = Date.now(), note = null}) {
  const el = useRef(null), map = useRef(null), drawn = useRef(null);
  const [failed, setFailed] = useState(false), [ready, setReady] = useState(false), [at, setAt] = useState(null);
  const data = {mode, route, points, area};
  const pts = mode === 'route' ? thinRoute(route?.points) : [];
  useEffect(() => {
    let gone = false, ro = null;
    loadLeaflet(el.current.ownerDocument).then(L => {
      if (gone) return;
      map.current = {L, map: baseMap(L, el.current, {kiosk})};
      setReady(true);
      ro = new ResizeObserver(() => { map.current?.map.invalidateSize({pan: false}); drawn.current?.fit(); });
      ro.observe(el.current);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; ro?.disconnect(); drawn.current?.remove(); map.current?.map.remove(); map.current = null; };
  }, []);
  const key = JSON.stringify([mode, route?.points?.length, route?.points?.[0]?.time, (points ?? []).map(p => [p.id, p.lat, p.lon]),
    area?.center?.lat, area?.center?.lon, (area?.zones ?? []).map(z => [z.id, z.latitude, z.longitude, z.radius_m])]);
  useEffect(() => {
    if (!ready || !map.current) return;
    drawn.current?.remove();
    drawn.current = drawMode(map.current.L, map.current.map, el.current, data);
    setAt(null);
  }, [ready, key]);
  useEffect(() => { if (at != null) drawn.current?.cursor(at); }, [at]);
  const summary = mapSummary(data, {now, timeZone});
  const zoom = d => () => map.current?.map[d > 0 ? 'zoomIn' : 'zoomOut']();
  const i = at ?? pts.length - 1;
  const near = mode === 'area' ? zonesNear(area?.center, area?.zones, area?.within_m ?? 5000) : [];
  const listed = mode === 'points' ? (points ?? []).filter(isPlace) : [];
  // the route's hidden table: at most 48 of its points, evenly
  const sampled = pts.length > 48 ? Array.from({length: 48}, (_, k) => pts[Math.round(k * (pts.length - 1) / 47)]) : pts;
  return html`<figure class=${`dm${kiosk ? ' kiosk' : ''}`} aria-label=${label} data-mode=${mode}>
    <div class="dm-box">
      <div class="dm-map" ref=${el} aria-hidden="true"></div>
      ${failed ? html`<p class="dm-note" role="status">Map unavailable</p>` : null}
      ${!kiosk && !failed ? html`<div class="dm-zoom" role="group" aria-label="Zoom"><button type="button" class="dk-btn icon" aria-label="Zoom in" onClick=${zoom(1)}>+</button>
        <button type="button" class="dk-btn icon" aria-label="Zoom out" onClick=${zoom(-1)}>−</button></div>` : null}
      <span class="dm-credit">© OpenStreetMap contributors</span>
    </div>
    ${mode === 'route' && pts.length > 1 && !kiosk ? html`<label class="dm-slider"><span class="dm-at" aria-live="polite">${dateTimeText(new Date(pts[i].t), {now, timeZone})}</span>
      <input type="range" min="0" max=${pts.length - 1} value=${i} aria-label="Along the route" aria-valuetext=${dateTimeText(new Date(pts[i].t), {now, timeZone})}
        onInput=${ev => setAt(Number(ev.currentTarget.value))} /></label>` : null}
    ${kiosk ? null : html`<p class="ds-summary dm-summary">${summary}</p>`}
    ${note && !kiosk ? html`<p class="dm-line">${note}</p>` : null}
    ${near.length && !kiosk ? html`<ul class="dm-list" aria-label="Zones">${near.map(z => html`<li key=${z.id} data-zone=${z.id}><${Glyph} name="place" size=${14} /><b>${z.name}</b>
      <span>${joinText([z.inside ? 'here' : `${metresText(z.distance_m)} away`, `${metresText(z.radius_m)} radius`])}</span></li>`)}</ul>` : null}
    ${listed.length && !kiosk ? html`<ul class="dm-list" aria-label="Places">${listed.map(p => html`<li key=${p.id ?? `${p.lat},${p.lon}`}><${Glyph} name=${p.glyph ?? 'place'} size=${14} />
      ${p.onOpen ? html`<button type="button" class="dk-btn text" onClick=${() => p.onOpen()}>${p.label ?? 'Place'}</button>` : html`<b>${p.label ?? 'Place'}</b>`}
      ${p.time ? html`<span>${dateTimeText(new Date(p.time), {now, timeZone})}</span>` : null}</li>`)}</ul>` : null}
    ${mode === 'route' && sampled.length ? html`<div class="dk-sr"><table><caption>${label}</caption><thead><tr><th>Time</th><th>Latitude</th><th>Longitude</th></tr></thead>
      <tbody>${sampled.map(p => html`<tr key=${p.t}><td>${dateTimeText(new Date(p.t), {now, timeZone})}</td><td>${p.lat.toFixed(5)}</td><td>${p.lon.toFixed(5)}</td></tr>`)}</tbody></table></div>` : null}
  </figure>`;
}

const quiet = e => ['unsupported', 'not-set-up'].includes(e?.code) || [401, 403, 404].includes(e?.status);
const zoneOf = tz => tz ?? DateTimeFormatter().resolvedOptions().timeZone;

/** A trip's days as location history's bounds: from its first day's midnight through the last's end, in `timeZone`; null for a
 *  month-only trip (too wide to be a route). */
export function tripBounds(trip, timeZone) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(trip?.from ?? '')) return null;
  const to = day.test(trip?.to ?? '') ? trip.to : trip.from, tz = zoneOf(timeZone);
  return {from: zonedWallTimeToUtc(tz, trip.from, '00:00').toISOString(), through: new Date(+zonedWallTimeToUtc(tz, shiftDateStr(to, 1), '00:00') - 1).toISOString()};
}
const PAGE = 5000, MAX_POINTS = 20000;
/** A trip's route from bridge's location history (`bridge.locationHistory`, the page's member's), paged to at most 20,000 points;
 *  nothing when there is none or the host cannot read it. */
export function TripRoute({host, trip, member = null, timeZone, now = Date.now()}) {
  const [state, setState] = useState({loading: true}), [retry, setRetry] = useState(0);
  const who = member ?? pageMember()?.id ?? null, bounds = tripBounds(trip, timeZone);
  useEffect(() => {
    if (!who || !bounds) return undefined;
    let active = true;
    setState({loading: true});
    (async () => {
      const points = [];
      for (let offset = 0; offset < MAX_POINTS; offset += PAGE) {
        const answer = await host.call('bridge.locationHistory', {member: who, ...bounds, limit: PAGE, offset});
        const page = answer?.points ?? [];
        points.push(...page.map(p => ({lat: p.latitude, lon: p.longitude, time: p.time})));
        if (page.length < PAGE) break;
      }
      return points;
    })().then(points => { if (active) setState({points}); }, error => { if (active) setState({error}); });
    return () => { active = false; };
  }, [host, who, bounds?.from, bounds?.through, retry]);
  if (!who || !bounds) return null;
  if (state.error) return quiet(state.error) ? null : html`<${Failure} backend="bridge" error=${state.error} retry=${() => setRetry(n => n + 1)} host=${host} />`;
  if (state.loading) return html`<${Skeleton} inline=${true} />`;
  if (!state.points.length) return null;
  return html`<${MapView} mode="route" label="Route" route=${{points: state.points}} timeZone=${timeZone} now=${now} />`;
}

/** A property's place (bridge's `location`) and Habitat's zones near it (`habitat.zones`); nothing without a location. */
export function PropertyArea({host, home, within = 5000}) {
  const [state, setState] = useState({loading: true}), loc = home?.location;
  const center = loc && Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude)) ? {lat: Number(loc.latitude), lon: Number(loc.longitude), label: home.name} : null;
  useEffect(() => {
    if (!center) return undefined;
    let active = true;
    host.call('habitat.zones', {}).then(answer => { if (active) setState({zones: answer?.zones ?? []}); }, error => { if (active) setState({zones: [], error}); });
    return () => { active = false; };
  }, [host, home?.id]);
  if (!center) return null;
  if (state.loading) return html`<${Skeleton} inline=${true} />`;
  return html`<${MapView} mode="area" label=${`${home.name} on the map`} area=${{center, zones: state.zones, within_m: within}}
    note=${state.error && !quiet(state.error) ? 'Habitat’s zones did not load.' : null} />`;
}
