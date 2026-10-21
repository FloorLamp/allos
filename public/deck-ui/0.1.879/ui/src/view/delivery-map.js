// The camera wall's delivery map (contract/house.md *Delivery map*): while Habitat's band carries a `delivery`, the dasher and the
// house on Deck's map (view/map-view.js `baseMap`, a kiosk's) in the featured tile's place. A kiosk's: no controls, no gestures; both pins kept
// in view with padding, the dasher gliding from one reported position to the next, a line between them; the header names the order.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {timeText} from '../format.js';
import {formatQuantity} from '../quantity.js';
import {loadLeaflet} from './leaflet.js';
import {baseMap, pinIcon} from './map-view.js';

const html = htm.bind(h);

/** Habitat's stages (habitat docs/contract/wall.md *Delivery*) as the header says them. */
export const STAGES = {confirmed: 'Confirmed', on_way: 'Picked up', almost: 'Nearby'};
/** `850 m`, `1.2 km`. */
export function distanceText(m) {
  const near = Math.round(m / 10) * 10;
  return near < 1000 ? formatQuantity({value: near, unit: 'm'}) : formatQuantity({value: m / 1000, unit: 'km', precision: 1});
}
/** The header: `DoorDash · Picked up · ETA 6:42 PM · 1.2 km`, each part only when known. */
export function deliveryLine(d, {timeZone} = {}) {
  const eta = d.eta ? timeText(d.eta, {timeZone}) : '';
  return [d.service, STAGES[d.stage], eta ? `ETA ${eta}` : null, Number.isFinite(d.distance_m) ? distanceText(d.distance_m) : null].filter(Boolean).join(' · ');
}

/** The glide between two reports: as long as the last gap between them (house-agent writes every 5 s), within bounds. */
export const GLIDE_MIN_MS = 300, GLIDE_MAX_MS = 5000;
const PAD = 48, MAX_ZOOM = 17;

/** The map in `el`: `show(delivery)` after each report, `resize()`, `remove()`. */
export function deliveryMap(L, el, {top = 0} = {}) {
  const doc = el.ownerDocument, map = baseMap(L, el, {kiosk: true}), still = map.still;
  const icon = (kind, glyph) => pinIcon(L, doc, kind, glyph);
  let home = null, dasher = null, line = null, frame = 0, last = 0, target = null;
  const fit = (first) => map.fitBounds(L.latLngBounds([home.getLatLng(), target]), {paddingTopLeft: [PAD, PAD + top], paddingBottomRight: [PAD, PAD],
    maxZoom: MAX_ZOOM, animate: !first && !still});
  // where the dasher is drawn (`data-dasher`, the tests' measure of the glide)
  const place = at => { dasher.setLatLng(at); line.setLatLngs([home.getLatLng(), at]); el.dataset.dasher = `${at.lat.toFixed(6)},${at.lng.toFixed(6)}`; };
  return {
    show(d) {
      const h0 = L.latLng(d.home.lat, d.home.lon), next = L.latLng(d.dasher.lat, d.dasher.lon), now = performance.now();
      const first = !home;
      if (first) {
        home = L.marker(h0, {icon: icon('home', 'house'), keyboard: false, interactive: false}).addTo(map);
        line = L.polyline([h0, next], {className: 'dm-route', interactive: false}).addTo(map);
        dasher = L.marker(next, {icon: icon('dasher', 'delivery'), keyboard: false, interactive: false, zIndexOffset: 1000}).addTo(map);
      } else if (!home.getLatLng().equals(h0)) home.setLatLng(h0);
      cancelAnimationFrame(frame);
      const from = dasher.getLatLng(), glide = Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, now - last));
      target = next;
      last = now;
      fit(first);
      if (first || still || from.equals(next)) place(next);
      else {
        const step = t => {
          const k = Math.min(1, Math.max(0, (t - now) / glide));
          place(L.latLng(from.lat + (next.lat - from.lat) * k, from.lng + (next.lng - from.lng) * k));
          if (k < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      }
    },
    resize() { map.invalidateSize({pan: false}); if (target) fit(true); },
    remove() { cancelAnimationFrame(frame); map.remove(); },
  };
}

/** The featured tile's place while an order is on its way: the header, the map (or a note when it cannot load), OSM's credit. */
export function DeliveryMap({delivery, timeZone}) {
  const el = useRef(null), head = useRef(null), map = useRef(null), latest = useRef(delivery), [failed, setFailed] = useState(false);
  latest.current = delivery;
  useEffect(() => {
    let gone = false, ro = null;
    loadLeaflet(el.current.ownerDocument).then(L => {
      if (gone) return;
      map.current = deliveryMap(L, el.current, {top: head.current?.offsetHeight ?? 0});
      map.current.show(latest.current);
      ro = new ResizeObserver(() => map.current?.resize());
      ro.observe(el.current);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; ro?.disconnect(); map.current?.remove(); map.current = null; };
  }, []);
  const {dasher: {lat, lon}, home} = delivery;
  useEffect(() => { map.current?.show(delivery); }, [lat, lon, home.lat, home.lon]);
  const line = deliveryLine(delivery, {timeZone});
  return html`<section class="dh-wall-map" aria-label=${`Delivery: ${line}`} data-stage=${delivery.stage}>
    <div class="dh-map" ref=${el}></div>
    <header class="dh-map-head tone-purple" ref=${head}><${Glyph} name="delivery" size=${26} /><b>${line}</b></header>
    ${failed ? html`<p class="dh-wall-note dh-map-note" role="status">Map unavailable</p>` : null}
    <span class="dh-map-credit">© OpenStreetMap contributors</span>
  </section>`;
}
