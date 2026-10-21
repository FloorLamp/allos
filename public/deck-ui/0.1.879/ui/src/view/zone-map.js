// The zones' map (contract/house.md *Zones*): Leaflet (leaflet.js: pinned, from cdnjs with its sha384; the page's policy, mapPolicy,
// admits that origin and OpenStreetMap's tiles alone) with each zone a circle and its name. The selected zone's circle is drawn from its draft: drag the
// circle or its centre handle to move it, its edge handle to resize it; each drag ends in one model change, never a write (Save writes).
// A click on empty ground is the model's (`mapClick`: add, move a new zone, or let the selection go).
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {readOnly, syncState, zoneName} from '../zones.js';
import {LEAFLET, loadLeaflet} from './leaflet.js';
import {StateBlock} from './page-state.js';

const html = htm.bind(h);

/** The map over `model` (src/zones.js): `draw()` after each change, `remove()`. Leaflet's zoom and attribution controls set markup
 *  from strings, so the page draws its own (ZoneMap); the labels and handles are elements. */
export function zoneMap(L, el, model) {
  // a view from the start, so layers join it at once (Leaflet holds them back until the map has one); the zones' bounds once loaded
  const still = !!el.ownerDocument.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const map = L.map(el, {zoomSnap: 0.5, worldCopyJump: true, zoomControl: false, attributionControl: false,
    zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still}).setView([20, 0], 2);
  L.tileLayer(LEAFLET.tiles, {maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin'}).addTo(map);
  const layers = new Map();
  let handles = null, seen = -1, drag = null, quiet = false;
  map.on('click', e => { if (!quiet) model.mapClick(e.latlng.lat, e.latlng.lng); });
  const editing = id => id === model.selected && model.editable();
  // the circle's east edge from its centre and radius (not its drawn bounds, which lag a zoom until it is redrawn)
  const edge = circle => { const at = circle.getLatLng(); return L.latLng(at.lat, at.lng + circle.getRadius() / (111320 * Math.cos(at.lat * Math.PI / 180))); };
  // a drag's end: the map's click that follows it is the drag's, not a click on the ground
  const settle = () => { quiet = true; setTimeout(() => { quiet = false; }, 0); };

  // the circle itself, dragged with the mouse: the map holds still, the circle follows, one move at the end
  function startDrag(id, ev) {
    if (!editing(id)) return;
    L.DomEvent.stop(ev);
    const {circle} = layers.get(id);
    drag = {id, from: ev.latlng, center: circle.getLatLng(), moved: false};
    map.dragging.disable();
    map.on('mousemove', dragging);
    L.DomEvent.on(el.ownerDocument, 'mouseup', endDrag);
  }
  function dragging(e) {
    if (!drag) return;
    drag.moved = true;
    const at = L.latLng(drag.center.lat + e.latlng.lat - drag.from.lat, drag.center.lng + e.latlng.lng - drag.from.lng);
    layers.get(drag.id).circle.setLatLng(at);
    place();
  }
  function endDrag() {
    map.off('mousemove', dragging);
    L.DomEvent.off(el.ownerDocument, 'mouseup', endDrag);
    map.dragging.enable();
    const done = drag;
    drag = null;
    if (!done?.moved) return;
    settle();
    const at = layers.get(done.id)?.circle.getLatLng();
    if (at) model.move(at.lat, at.lng);
  }

  // the selected zone's handles: its centre (move) and its east edge (resize)
  function place() {
    if (!handles) return;
    const {circle} = layers.get(handles.id);
    handles.center.setLatLng(circle.getLatLng());
    handles.edge.setLatLng(edge(circle));
  }
  function handle(kind, title) {
    const marker = L.marker([0, 0], {draggable: true, keyboard: false, title, alt: title, zIndexOffset: 1000, bubblingMouseEvents: false,
      icon: L.divIcon({className: `dz-handle ${kind}`, iconSize: [18, 18], html: el.ownerDocument.createElement('span')})}).addTo(map);
    marker.on('dragstart', () => { quiet = true; });
    return marker;
  }
  function showHandles(id) {
    if (handles?.id === id) return place();
    hideHandles();
    const center = handle('move', 'Drag to move the zone'), size = handle('size', 'Drag to resize the zone');
    handles = {id, center, edge: size};
    center.on('drag', () => { layers.get(id).circle.setLatLng(center.getLatLng()); size.setLatLng(edge(layers.get(id).circle)); });
    center.on('dragend', () => { settle(); const at = center.getLatLng(); model.move(at.lat, at.lng); });
    size.on('drag', () => { const {circle} = layers.get(id); circle.setRadius(Math.max(1, map.distance(circle.getLatLng(), size.getLatLng()))); labels(); });
    size.on('dragend', () => { settle(); model.resize(layers.get(id).circle.getRadius()); });
    place();
  }
  function hideHandles() {
    if (!handles) return;
    handles.center.remove(); handles.edge.remove(); handles = null;
  }

  function draw() {
    const shown = model.zones.filter(z => !(z.id === model.selected && model.draft)).map(z => [z.id, z]);
    if (model.draft) shown.push([model.selected, {...(model.zone(model.selected) ?? {}), ...model.draft}]);
    for (const [id, layer] of layers) if (!shown.some(([s]) => s === id)) { layer.circle.remove(); layers.delete(id); }
    for (const [id, z] of shown) {
      let layer = layers.get(id);
      if (!layer) {
        const label = el.ownerDocument.createElement('span');
        const circle = L.circle([z.latitude, z.longitude], {radius: z.radius_m, className: 'dz-zone', bubblingMouseEvents: false}).addTo(map);
        circle.bindTooltip(label, {permanent: true, direction: 'bottom', className: 'dz-label', opacity: 1});
        circle.on('click', ev => { L.DomEvent.stop(ev); if (!quiet) model.select(id); });
        circle.on('mousedown', ev => startDrag(id, ev));
        layers.set(id, layer = {circle, label});
      }
      if (drag?.id !== id) { layer.circle.setLatLng([z.latitude, z.longitude]); layer.circle.setRadius(z.radius_m); }
      layer.label.textContent = id === 'new' ? z.name?.trim() || 'New zone' : z.name?.trim() || zoneName(z);
      const path = layer.circle.getElement();
      for (const [name, on] of [['sel', id === model.selected], ['core', readOnly(z)], ['failed', syncState(z)?.text === 'Failed'], ['draft', id === 'new'], ['movable', editing(id)]])
        path?.classList.toggle(name, on);
      layer.circle.getTooltip()?.getElement()?.classList.toggle('sel', id === model.selected);
      if (id === model.selected) layer.circle.bringToFront();
    }
    labels();
    if (model.selected && model.editable() && layers.has(model.selected)) showHandles(model.selected); else hideHandles();
    el.classList.toggle('adding', model.adding);
    if (!model.loading && model.focus.seq !== seen) { seen = model.focus.seq; look(model.focus); }
  }
  // each name just under its circle, whatever the zoom: over the middle it would hide a small circle and the centre handle
  function labels() {
    for (const {circle} of layers.values()) {
      const tip = circle.getTooltip(), at = circle.getLatLng();
      const r = map.latLngToContainerPoint(edge(circle)).x - map.latLngToContainerPoint(at).x;
      tip.options.offset = L.point(0, Math.max(4, Math.round(r) + 2));
      tip.update();
    }
  }
  map.on('zoomend', labels);
  // while the map flies (a selection, a found place), it says so: drags and clicks wait for it at rest
  map.on('movestart zoomstart', () => { el.dataset.moving = 'true'; });
  map.on('moveend', () => { delete el.dataset.moving; });
  function look(where) {
    if (where.zone && layers.has(where.zone)) return map.fitBounds(layers.get(where.zone).circle.getBounds(), {padding: [48, 48], maxZoom: 16});
    if (Number.isFinite(where.latitude)) return map.setView([where.latitude, where.longitude], 16);
    const all = [...layers.values()].map(l => l.circle.getBounds());
    if (!all.length) return map.setView([20, 0], 2);
    map.fitBounds(all.reduce((b, x) => b.extend(x), L.latLngBounds(all[0].getSouthWest(), all[0].getNorthEast())), {padding: [32, 32], maxZoom: 15});
  }
  const resized = new ResizeObserver(() => map.invalidateSize());
  resized.observe(el);
  return {map, draw, remove() { resized.disconnect(); map.remove(); }};
}

/** The map in the page: Leaflet loaded, then drawn after each model change; a map that cannot load says so and the list still works. */
export function ZoneMap({model}) {
  const el = useRef(null), map = useRef(null), [state, setState] = useState('loading'), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setState('loading');
    loadLeaflet(el.current.ownerDocument).then(L => {
      if (gone) return;
      map.current = zoneMap(L, el.current, model);
      map.current.draw();
      setState('ready');
    }, () => { if (!gone) setState('failed'); });
    return () => { gone = true; map.current?.remove(); map.current = null; };
  }, [model, attempt]);
  useEffect(() => { map.current?.draw(); });
  const zoom = by => map.current?.map[by > 0 ? 'zoomIn' : 'zoomOut']();
  return html`<div class="dz-map-wrap">
    <div ref=${el} class="dz-map" role="region" aria-label="Map of zones" aria-busy=${state === 'loading' ? 'true' : null}></div>
    ${state === 'ready' ? html`<div class="dz-zoom" role="group" aria-label="Zoom">
        <button type="button" class="dk-btn icon" aria-label="Zoom in" onClick=${() => zoom(1)}>+</button>
        <button type="button" class="dk-btn icon" aria-label="Zoom out" onClick=${() => zoom(-1)}>−</button>
      </div>
      <p class="dz-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors ·
        <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a></p>` : null}
    ${state === 'failed' ? html`<div class="dz-map-state"><${StateBlock} glyph="map" title="The map didn’t load" line="The list still works; try the map again."
      action="Try again" onAction=${() => setAttempt(n => n + 1)} warn=${true} /></div>` : null}
  </div>`;
}
