// Places on a map (contract/media.md *Map*), no DOM: distances, the zones near a place, a route thinned to what a map can draw and its
// words. Coordinates always come with the data; nothing here (or in the map) asks a geocoder.
import {countText, dateTimeText, isoDay, joinText, timeText} from './format.js';
import {formatQuantity} from './quantity.js';

const R = 6371008.8, rad = d => d * Math.PI / 180;
/** Metres between two {lat, lon} (haversine). */
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
/** A real coordinate pair. */
export const isPlace = p => p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
/** `850 m`, `1.2 km`, `38 km` (the number and its unit never split across lines). */
export function metresText(m) {
  const km = Math.round(m / 100) / 10;
  const q = m < 1000 ? {value: Math.round(m / 10) * 10, unit: 'm'} : {value: km < 10 ? km : Math.round(km), unit: 'km', precision: km < 10 && !Number.isInteger(km) ? 1 : 0};
  return formatQuantity(q).replace(' ', '\u00a0');
}

/** Habitat's zones (habitat docs/contract/zones.md) whose circle comes within `within` metres of `center`, nearest first, each with
 *  its distance from the centre (0 inside it). */
export function zonesNear(center, zones, within = 5000) {
  if (!isPlace(center)) return [];
  return (zones ?? []).map(z => ({...z, at: {lat: Number(z.latitude), lon: Number(z.longitude)}, radius_m: Number(z.radius_m) || 0}))
    .filter(z => isPlace(z.at)).map(z => {
      const d = distanceM(center, z.at);
      return {...z, distance_m: d, inside: d <= z.radius_m};
    }).filter(z => z.distance_m - z.radius_m <= within).sort((a, b) => a.distance_m - b.distance_m);
}

/** A route's points in time order with real coordinates, at most `max` kept evenly (the first and last always). */
export function thinRoute(points, max = 2000) {
  const ok = (points ?? []).map(p => ({...p, lat: Number(p.lat ?? p.latitude), lon: Number(p.lon ?? p.longitude), t: Date.parse(p.time)}))
    .filter(p => isPlace(p) && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (ok.length <= max) return ok;
  const out = [], step = (ok.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(ok[Math.round(i * step)]);
  return out;
}
/** A route's length in metres along its points. */
export const routeLength = pts => pts.slice(1).reduce((n, p, i) => n + distanceM(pts[i], p), 0);

/** From one moment to another: `Oct 3, 9:00 AM–12:59 PM` on one day, else both in full. */
export function when(a, b, {now, timeZone} = {}) {
  const from = dateTimeText(new Date(a), {now, timeZone});
  if (a === b) return from;
  return isoDay(new Date(a), {timeZone}) === isoDay(new Date(b), {timeZone}) ? `${from}–${timeText(new Date(b), {timeZone})}` : `${from}–${dateTimeText(new Date(b), {now, timeZone})}`;
}

/** The words under a map: `Route: 412 points, Oct 3, 9:12 AM–4:40 PM, 38 km`; `3 zones within 5 km: Home (here), …`;
 *  `4 places`. */
export function mapSummary({mode, route, points, area}, {now = Date.now(), timeZone} = {}) {
  if (mode === 'route') {
    const pts = thinRoute(route?.points, Infinity);
    if (!pts.length) return 'No route recorded';
    return `Route: ${joinText([`${countText(pts.length)} ${pts.length === 1 ? 'point' : 'points'}`,
      when(pts[0].t, pts.at(-1).t, {now, timeZone}), metresText(routeLength(pts))], ', ')}`;
  }
  if (mode === 'area') {
    const near = zonesNear(area?.center, area?.zones, area?.within_m ?? 5000);
    const lead = `${area?.center?.label ?? 'This place'}`;
    if (!near.length) return `${lead}: no zones within ${metresText(area?.within_m ?? 5000)}`;
    return `${lead}: ${countText(near.length)} ${near.length === 1 ? 'zone' : 'zones'} within ${metresText(area?.within_m ?? 5000)}: ${near.map(z => `${z.name} (${z.inside ? 'here' : metresText(z.distance_m)})`).join(', ')}`;
  }
  const ok = (points ?? []).filter(isPlace);
  return ok.length ? `${countText(ok.length)} ${ok.length === 1 ? 'place' : 'places'}` : 'No places';
}
