import {readBridge} from './host/host.js';
import {describeFailure} from './failure.js';
import {maskedIdentifier} from './identifiers.js';
// Vehicle papers are authoritative; live fields require exact identities or explicit HA bindings.
const list = (r, key) => Array.isArray(r) ? r : r?.[key] ?? [];
export const vehicleQuery = q => /^(vehicles?|ev9)$/i.test(String(q).trim());
const known = v => v != null && !['', 'unknown', 'unavailable'].includes(v);
const number = v => known(v) && Number.isFinite(Number(v)) ? Number(v) : null;
const same = (a, b) => a && b && String(a).toLowerCase() === String(b).toLowerCase();

export function liveVehicle(vehicle, entities, states, mapping = {}) {
  const state = new Map(states.map(s => [s.entity_id, s]));
  const values = {}, updated = [];
  for (const field of ['location', 'charge', 'fuel', 'range', 'locked', 'doors', 'climate', 'charging']) {
    const explicit = mapping[field];
    const matches = entities.filter(e => {
      if (explicit) return e.id === explicit;
      const a = e.attributes ?? {};
      return a.field === field && (vehicle.vin ? same(a.vin, vehicle.vin) : same(a.make, vehicle.make) && same(a.model, vehicle.model));
    });
    if (matches.length !== 1) continue;
    const e = matches[0], s = state.get(e.id), a = {...e.attributes, ...s?.attributes};
    if (field === 'location' && s && s.state !== 'unavailable') {
      const lat = number(a.latitude), lon = number(a.longitude);
      if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) values.location = {lat, lon};
    } else if (['charge', 'fuel', 'range'].includes(field)) {
      const n = number(s?.state);
      if (n != null && n >= 0 && (field === 'range' || n <= 100)) {
        // Unknown range units must not be labelled miles.
        if (field !== 'range' || ['mi', 'km'].includes(a.unit_of_measurement)) values[field] = field === 'range' && a.unit_of_measurement === 'km' ? n / 1.609344 : n;
      }
    } else if (known(s?.state)) values[field] = String(s.state);
    if (s?.last_updated || s?.last_changed) updated.push(s.last_updated ?? s.last_changed);
  }
  return {...values, updated: updated.sort()[0] ?? null};
}

export function vehiclePhotos(vehicle, results) {
  if (!vehicle.make || !vehicle.model) return [];
  const words = `${vehicle.make} ${vehicle.model}`.toLowerCase().split(/\s+/);
  const seen = new Set();
  return results.map(r => r.document).filter(d => {
    const text = `${d?.title ?? ''} ${d?.snippet ?? ''}`.toLowerCase();
    if (d?.source !== 'immich' || !d.url || seen.has(d.id) || !words.every(w => text.includes(w))) return false;
    seen.add(d.id); return true;
  });
}
export const paperPhotos = (paper, photos) => photos.filter(p => p.date && paper.document?.date && p.date.slice(0, 10) === paper.document.date.slice(0, 10));

export function vehicleTiles(live) {
  return [
    ...['charge', 'fuel', 'range'].map(key => ({key, label: {charge: 'Charge', fuel: 'Fuel', range: 'Range'}[key], quantity: {value: live[key], ...(key === 'range' ? {unit: 'mi'} : {format: 'percent'})}})),
    ...['locked', 'doors', 'climate', 'charging'].map(key => ({key, label: {locked: 'Locks', doors: 'Doors open', climate: 'Climate', charging: 'Charging'}[key], value: live[key] ?? 'Unknown'})),
  ];
}

export function createVehicles(host, {mapping = {}} = {}) {
  let stopped = false, generation = 0, request = null;
  let entities = [], states = [], streaming = false;
  const sourceVins = new Map(), photoRequests = new Map();
  const cancelPhotos = () => {
    for (const {request, car} of photoRequests.values()) { request.abort(); car.photosLoading = false; }
    photoRequests.clear();
  };
  const subscribers = new Set();
  const off = host.on?.('habitat.state', event => {
    if (stopped || !event?.entity_id) return;
    states = states.filter(s => s.entity_id !== event.entity_id);
    if (event.new) states.push({...event.new, entity_id: event.entity_id});
    for (const car of model.cars) car.live = liveVehicle({...car.vehicle, vin: sourceVins.get(car.vehicle.id)}, entities, states, mapping[car.vehicle.id]);
    changed();
  });
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    liveAvailable: false, cars: [], loading: false, warming: false, error: null,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    /** Only expanded cars on the visible collection page may search for photos. Successful results live until Refresh. */
    showPhotos(ids = []) {
      if (stopped) return Promise.resolve();
      const visible = new Set(ids), work = [];
      let changedState = false;
      for (const [id, pending] of photoRequests) if (!visible.has(id)) {
        pending.request.abort(); pending.car.photosLoading = false; photoRequests.delete(id); changedState = true;
      }
      for (const car of model.cars) {
        if (!visible.has(car.vehicle.id) || !car.vehicle.make || !car.vehicle.model || car.photosLoaded) continue;
        const pending = photoRequests.get(car.vehicle.id);
        if (pending) { work.push(pending.promise); continue; }
        const request = new AbortController(), current = generation;
        const active = () => !stopped && !request.signal.aborted && current === generation && model.cars.includes(car);
        car.photosLoading = true; changedState = true;
        const entry = {request, car};
        photoRequests.set(car.vehicle.id, entry);
        entry.promise = (async () => {
          try {
            const answer = await host.call('bridge.find', {q: `${car.vehicle.make} ${car.vehicle.model}`, limit: 50}, {signal: request.signal});
            if (active()) { car.photos = vehiclePhotos(car.vehicle, list(answer, 'results')); car.photosLoaded = true; }
          } catch (e) {
            if (active()) { car.warnings.push(describeFailure('bridge', e)); car.photosLoaded = true; }
          } finally {
            if (photoRequests.get(car.vehicle.id) === entry) photoRequests.delete(car.vehicle.id);
            if (active()) { car.photosLoading = false; changed(); }
          }
        })();
        work.push(entry.promise);
      }
      // The visible set is delivered from a view effect; notify after that commit to avoid reentering its render.
      if (changedState) queueMicrotask(() => { if (!stopped) changed(); });
      return Promise.all(work);
    },
    async refresh({vehicle = null} = {}) {
      if (stopped) return;
      request?.abort(); cancelPhotos();
      request = new AbortController();
      const signal = request.signal;
      const current = ++generation;
      model.warming = false; model.loading = true; model.error = null; model.liveAvailable = false; changed();
      try {
        const answer = vehicle ? {results: [{vehicle}]} : await readBridge(host, 'bridge.vehicles', {}, {signal,
          snapshot: answer => { if (model.cars.length) return; model.cars = list(answer, 'results').filter(r => r.vehicle).sort((a, b) => (b.vehicle.papers?.length ?? 0) - (a.vehicle.papers?.length ?? 0)).map(r => ({vehicle: {...r.vehicle, vin: r.vehicle.vin ? maskedIdentifier(r.vehicle.vin) : undefined, plate: r.vehicle.plate ? maskedIdentifier(r.vehicle.plate) : undefined}, live: {}, photos: [], photosLoading: false, photosLoaded: false, warnings: []})); changed(); },
          warming: () => { if (!signal.aborted) { model.warming = true; changed(); } },
        });
        const active = () => !stopped && current === generation && !signal.aborted;
        if (!active()) return;
        sourceVins.clear();
        const cars = list(answer, 'results').filter(r => r.vehicle).sort((a, b) => (b.vehicle.papers?.length ?? 0) - (a.vehicle.papers?.length ?? 0)).map(r => {
          sourceVins.set(r.vehicle.id, r.vehicle.vin);
          return {vehicle: {...r.vehicle, vin: r.vehicle.vin ? maskedIdentifier(r.vehicle.vin) : undefined,
            plate: r.vehicle.plate ? maskedIdentifier(r.vehicle.plate) : undefined}, live: {}, photos: [], photosLoading: false, photosLoaded: false, warnings: []};
        });
        // Papers are the collection. Optional photo and telemetry reads must never hold them back.
        model.cars = cars; model.warming = false; model.loading = false; changed();
        const telemetry = async () => {
          if (!host.backends?.includes('habitat')) return;
          try {
            const [ents, sts] = await Promise.all([host.call('habitat.entities', {}, {signal}), host.call('habitat.states', {}, {signal})]);
            if (!active()) return;
            model.liveAvailable = true;
            entities = list(ents, 'entities'); states = list(sts, 'states');
            for (const car of cars) car.live = liveVehicle({...car.vehicle, vin: sourceVins.get(car.vehicle.id)}, entities, states, mapping[car.vehicle.id]);
            if (!streaming) { streaming = true; host.call('habitat.stream', {query: {patterns: '*'}}).catch(() => { streaming = false; }); }
          } catch (e) { if (active() && !['unsupported', 'not-set-up'].includes(e.code)) for (const car of cars) car.warnings.push(describeFailure('Habitat', e)); }
          if (active()) changed();
        };
        await telemetry();
      } catch (e) { if (!stopped && current === generation) { model.cars = []; model.error = describeFailure('bridge', e); } }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); cancelPhotos(); off?.(); generation++; subscribers.clear(); },
  };
  return model;
}
