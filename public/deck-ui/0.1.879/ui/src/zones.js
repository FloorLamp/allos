// Zones (contract/house.md *Zones*; habitat docs/contract/zones.md): Habitat's places (presence, arrivals, zone names), no DOM. Reads
// `habitat.zones` ({zones, drift}); each change is one write (`habitat.zones.create`, `.update` with only what changed, `.delete`),
// which Habitat answers once Home Assistant has (or after 15 s), so the answer's `ha.state` is final: synced, pending (HA unreachable
// or no token; Habitat retries every five minutes) or failed (HA refused). Home Assistant's own Home (`id: 'home'`, `source:
// 'ha-core'`) is read only. Writes are the owner's. A search asks Habitat (`habitat.zones.geocode`, which asks OpenStreetMap's
// Nominatim; the browser never does), once per query.

export const DEFAULT_RADIUS = 100;
const FIELDS = ['name', 'latitude', 'longitude', 'radius_m'];
/** Every field a write takes (drift can name `passive` and `icon` too). */
const EDITABLE = [...FIELDS, 'passive', 'icon'];
const round = (n, places) => Number(Number(n).toFixed(places));
const near = (a, b) => Math.abs(a - b) < 1e-7;

/** A zone's name as the page shows it: unnamed ones by their Home Assistant entity. */
export const zoneName = z => z?.name?.trim() || (z?.ha?.entity_id ? `Unnamed (${z.ha.entity_id})` : 'Unnamed zone');
/** The sync chip: Synced, Pending or Failed (with Home Assistant's error). */
export function syncState(z) {
  const state = z?.ha?.state;
  if (state === 'failed') return {text: 'Failed', tone: 'bad', error: z.ha.error ?? 'Home Assistant did not take it'};
  if (state === 'pending') return {text: 'Pending', tone: 'warn', error: z.ha.error ?? 'Home Assistant has not taken it yet'};
  if (state === 'synced') return {text: 'Synced', tone: 'accent'};
  return null;
}
export const readOnly = z => z?.source === 'ha-core';

/** A draft's problems, by field (before Habitat's own check). */
export function draftErrors(d) {
  const errors = {};
  if (!d) return errors;
  if (!String(d.name ?? '').trim()) errors.name = 'A zone needs a name';
  if (!(Number.isFinite(d.radius_m) && d.radius_m >= 1 && d.radius_m <= 50000)) errors.radius_m = 'Radius is 1 to 50,000 m';
  if (!(Number.isFinite(d.latitude) && Math.abs(d.latitude) <= 90)) errors.latitude = 'Latitude is between -90 and 90';
  if (!(Number.isFinite(d.longitude) && Math.abs(d.longitude) <= 180)) errors.longitude = 'Longitude is between -180 and 180';
  return errors;
}

/** Why a write was refused, as the page says it. */
const refusal = (error, what) => error?.status === 409 ? 'Home is Home Assistant’s own zone: change it in Home Assistant'
  : error?.status === 403 ? 'Only the owner can change zones'
  : error?.status === 404 ? 'That zone is gone: the list is read again'
  : `Couldn’t ${what}: ${error?.message ?? error}`;

/** host: Deck's host with the habitat registry. canWrite: the member may change zones (the owner; others read). */
export function createZones(host, {canWrite = true} = {}) {
  const fns = new Set(), geocoded = new Map();
  let focusSeq = 0;
  const changed = () => { for (const fn of fns) fn(); };
  const z = {
    canWrite, loading: true, error: null, zones: [], drift: [],
    /** The selected zone's id, 'new' for a zone being added, or null. */
    selected: null, draft: null, adding: false, busy: false, confirming: false, fields: {}, outcome: null,
    /** What is on its way to Habitat (and Home Assistant): 'saving' or 'deleting', and the zone's id; null when nothing is. */
    writing: null,
    search: {q: '', busy: false, results: null, error: null},
    /** Where the map should look: {zone} (a zone's circle), {latitude, longitude} (a found place) or {all}; `seq` moves on each ask. */
    focus: {all: true, seq: 0},
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    start() { return z.load(); },
    stop() {},
    async load({quiet = false} = {}) {
      if (!quiet) { z.loading = true; z.error = null; changed(); }
      try {
        const answer = await host.call('habitat.zones', {});
        z.zones = Array.isArray(answer?.zones) ? answer.zones : [];
        z.drift = Array.isArray(answer?.drift) ? answer.drift : [];
        z.error = null;
        // a zone gone since (deleted elsewhere): nothing selected
        if (z.selected && z.selected !== 'new' && !z.zone(z.selected)) z.close();
      } catch (error) { if (!quiet) z.error = error; }
      z.loading = false;
      changed();
    },
    zone(id) { return z.zones.find(x => x.id === id) ?? null; },
    /** The selected zone's draft differs from what Habitat has (or is new). */
    dirty() {
      if (!z.draft) return false;
      if (z.selected === 'new') return true;
      const was = z.zone(z.selected);
      return !!was && FIELDS.some(f => f === 'name' ? (z.draft.name ?? '') !== (was.name ?? '') : !near(z.draft[f], was[f]));
    },
    editable() { return z.canWrite && !!z.draft && !readOnly(z.selected === 'new' ? null : z.zone(z.selected)); },
    /** Select a zone (the list or its circle); `focus` moves the map to it. Unsaved changes keep the selection where it is. */
    select(id, {focus = false} = {}) {
      if (id === z.selected) { if (focus) z.look({zone: id}); return; }
      if (z.dirty()) { z.say(`Save or cancel the changes to ${z.selected === 'new' ? 'the new zone' : zoneName(z.zone(z.selected))} first`, true); return; }
      const zone = z.zone(id);
      if (!zone) return;
      z.selected = id; z.adding = false; z.confirming = false; z.fields = {}; z.outcome = null;
      z.draft = {name: zone.name ?? '', latitude: zone.latitude, longitude: zone.longitude, radius_m: zone.radius_m};
      if (focus) z.look({zone: id}); else changed();
    },
    close() { z.selected = null; z.draft = null; z.adding = false; z.confirming = false; z.fields = {}; changed(); },
    look(where) { z.focus = {...where, seq: ++focusSeq}; changed(); },
    say(text, bad = false) { z.outcome = {text, bad}; changed(); },
    /** "Add zone": the next map click places it. */
    startAdd() {
      if (!z.canWrite) return;
      if (z.dirty() && z.selected !== 'new') { z.say(`Save or cancel the changes to ${zoneName(z.zone(z.selected))} first`, true); return; }
      z.selected = null; z.draft = null; z.confirming = false; z.fields = {};
      z.adding = true; z.outcome = {text: 'Click the map where the zone goes, or search for an address', bad: false};
      changed();
    },
    /** A new zone's draft at a point (a map click, a found place). */
    place(latitude, longitude, name = '') {
      const radius = z.selected === 'new' && z.draft ? z.draft.radius_m : DEFAULT_RADIUS;
      z.selected = 'new'; z.adding = false; z.confirming = false; z.fields = {}; z.outcome = null;
      z.draft = {name, latitude: round(latitude, 6), longitude: round(longitude, 6), radius_m: radius};
      changed();
    },
    /** A click on the map's empty ground: places a new zone while adding (or when nothing is selected), moves a new one, else
     *  lets the selection go. */
    mapClick(latitude, longitude) {
      if (!z.canWrite) { if (z.selected) z.close(); return; }
      if (z.selected === 'new') return z.move(latitude, longitude);
      if (z.adding || !z.selected) return z.place(latitude, longitude);
      if (z.dirty()) return z.say(`Save or cancel the changes to ${zoneName(z.zone(z.selected))} first`, true);
      z.close();
    },
    move(latitude, longitude) {
      if (!z.editable()) return;
      z.draft = {...z.draft, latitude: round(latitude, 6), longitude: round(longitude, 6)}; delete z.fields.latitude; delete z.fields.longitude;
      changed();
    },
    resize(radius) {
      if (!z.editable()) return;
      z.draft = {...z.draft, radius_m: Math.max(1, Math.round(radius))}; delete z.fields.radius_m;
      changed();
    },
    /** A field typed in the form: name (text), radius_m, latitude, longitude (numbers; NaN while not one). */
    edit(field, value) {
      if (!z.editable() || !FIELDS.includes(field)) return;
      z.draft = {...z.draft, [field]: field === 'name' ? String(value) : value === '' ? NaN : Number(value)};
      delete z.fields[field];
      changed();
    },
    cancel() {
      if (z.selected === 'new' || !z.selected) return z.close();
      const zone = z.zone(z.selected);
      z.draft = {name: zone.name ?? '', latitude: zone.latitude, longitude: zone.longitude, radius_m: zone.radius_m};
      z.fields = {}; z.confirming = false;
      changed();
    },
    /** Save: one write, create for a new zone, else update with only the fields that changed. */
    async save() {
      if (!z.editable() || z.busy || !z.dirty()) return;
      const errors = draftErrors(z.draft);
      if (Object.keys(errors).length) { z.fields = errors; changed(); return; }
      const d = {name: z.draft.name.trim(), latitude: round(z.draft.latitude, 6), longitude: round(z.draft.longitude, 6), radius_m: Math.round(z.draft.radius_m)};
      if (z.selected === 'new') {
        const zone = await z.write('habitat.zones.create', {body: d}, `Added ${d.name}`, 'new');
        if (zone) { const said = z.outcome; z.zones = [...z.zones, zone]; z.selected = null; z.draft = null; z.select(zone.id); z.outcome = said; changed(); }
        return;
      }
      const was = z.zone(z.selected), body = {};
      for (const f of FIELDS) if (f === 'name' ? d.name !== (was.name ?? '') : !near(d[f], was[f])) body[f] = d[f];
      await z.update(was, body, `Saved ${d.name}`);
    },
    async update(was, body, done) {
      const zone = await z.write('habitat.zones.update', {query: {id: was.id}, body}, done, was.id);
      if (!zone) return null;
      z.zones = z.zones.map(x => x.id === was.id ? zone : x);
      if (z.selected === was.id) z.draft = {name: zone.name ?? '', latitude: zone.latitude, longitude: zone.longitude, radius_m: zone.radius_m};
      changed();
      return zone;
    },
    /** One write, `id` the zone it is about ('new'); its zone as Habitat answered once Home Assistant had (its `ha.state` final, never
     *  assumed), or null with the reason said (field errors beside their fields). The list and the drift are read again after. */
    async write(op, args, done, id) {
      z.busy = true; z.writing = {kind: 'saving', id}; z.outcome = null; changed();
      try {
        const answer = await host.call(op, args);
        const zone = answer?.zone ?? null, sync = syncState(zone);
        z.say(sync && sync.text !== 'Synced' ? `${done}; Home Assistant: ${sync.text.toLowerCase()} (${sync.error})` : done, !!sync && sync.text === 'Failed');
        z.load({quiet: true});
        return zone;
      } catch (error) {
        if (error?.fields && Object.keys(error.fields).length) { z.fields = {...error.fields}; z.say('Habitat refused it: check the fields', true); }
        else { z.say(refusal(error, 'save'), true); if (error?.status === 404) z.load({quiet: true}); }
        return null;
      } finally { z.busy = false; z.writing = null; changed(); }
    },
    askDelete() { if (z.editable() && z.selected !== 'new') { z.confirming = true; changed(); } },
    keep() { z.confirming = false; changed(); },
    async remove() {
      const zone = z.zone(z.selected);
      if (!z.confirming || !zone || readOnly(zone) || z.busy) return;
      z.busy = true; z.writing = {kind: 'deleting', id: zone.id}; changed();
      try {
        // answered once Home Assistant has deleted its copy (or after 15 s)
        await host.call('habitat.zones.delete', {query: {id: zone.id}});
        z.zones = z.zones.filter(x => x.id !== zone.id);
        z.draft = null; z.selected = null; z.confirming = false;
        z.say(`Deleted ${zoneName(zone)}`);
        z.load({quiet: true});
      } catch (error) {
        z.say(refusal(error, 'delete'), true);
        if (error?.status === 404) z.load({quiet: true});
      } finally { z.busy = false; z.writing = null; changed(); }
    },
    /** A failed push again: the zone as Habitat has it, written once more. */
    retry(id) {
      const zone = z.zone(id);
      if (!z.canWrite || !zone || readOnly(zone) || z.busy) return;
      return z.update(zone, Object.fromEntries(FIELDS.map(f => [f, zone[f]])), `Sent ${zoneName(zone)} to Home Assistant again`);
    },
    /** The zone a drift entry is about (by its Home Assistant entity). */
    zoneOf(d) {
      return (d.entity_id ? z.zones.find(x => x.ha?.entity_id === d.entity_id) : null)
        // a zone Home Assistant deleted carries Habitat's own values
        ?? (d.differs === 'missing-in-ha' ? z.zones.find(x => !readOnly(x) && x.name === d.name) : null) ?? null;
    },
    /** A Habitat zone Home Assistant deleted: written again, which recreates it there. */
    async pushAgain(d) {
      const zone = z.zoneOf(d);
      if (!z.canWrite || z.busy || !zone || readOnly(zone)) return;
      await z.update(zone, Object.fromEntries(FIELDS.map(f => [f, zone[f]])), `Sent ${zoneName(zone)} to Home Assistant again`);
    },
    /** A Habitat zone Home Assistant deleted, deleted here too: selected with Delete's confirmation open. */
    deleteHere(d) {
      const zone = z.zoneOf(d);
      if (!z.canWrite || !zone || readOnly(zone)) return;
      z.select(zone.id, {focus: true});
      if (z.selected === zone.id) z.askDelete();
    },
    /** Home Assistant's version wins: create it here, or update ours with HA's values. */
    async takeHa(d) {
      if (!z.canWrite || z.busy) return;
      const values = {name: d.name, latitude: d.latitude, longitude: d.longitude, radius_m: d.radius_m};
      if (d.differs === 'missing-in-ha') return z.pushAgain(d);
      const zone = z.zoneOf(d);
      if (d.differs === 'missing-here' || !zone) {
        const made = await z.write('habitat.zones.create', {body: values}, `Added ${d.name} from Home Assistant`);
        if (made) { z.zones = [...z.zones, made]; changed(); }
        return;
      }
      const differs = Array.isArray(d.differs) && d.differs.length ? d.differs.filter(f => EDITABLE.includes(f)) : FIELDS;
      const ha = {...values, passive: d.passive, icon: d.icon};
      await z.update(zone, Object.fromEntries(differs.filter(f => ha[f] !== undefined).map(f => [f, ha[f]])), `Took Home Assistant’s ${zoneName({...zone, name: d.name})}`);
    },
    /** Habitat's version wins: written again, so Home Assistant takes it. */
    async keepHabitat(d) {
      const zone = z.zoneOf(d);
      if (!z.canWrite || z.busy || !zone || readOnly(zone)) return;
      const differs = Array.isArray(d.differs) && d.differs.length ? d.differs.filter(f => EDITABLE.includes(f)) : FIELDS;
      await z.update(zone, Object.fromEntries(differs.map(f => [f, zone[f]])), `Sent Habitat’s ${zoneName(zone)} to Home Assistant`);
    },
    /** Search for an address through Habitat; the same query never asks twice. */
    async find(q) {
      const query = String(q ?? '').trim();
      z.search = {q: query, busy: !!query, results: null, error: null}; changed();
      if (!query) return;
      const key = query.toLowerCase();
      try {
        if (!geocoded.has(key)) {
          const answer = await host.call('habitat.zones.geocode', {query: {q: query}});
          geocoded.set(key, Array.isArray(answer?.results) ? answer.results.filter(r => Number.isFinite(r?.latitude) && Number.isFinite(r?.longitude)) : []);
        }
        if (z.search.q === query) z.search = {q: query, busy: false, results: geocoded.get(key), error: null};
      } catch (error) {
        // 502: Habitat could not reach Nominatim (nothing cached); the map still places zones
        if (z.search.q === query) z.search = {q: query, busy: false, results: null, error, unavailable: error?.status === 502};
      }
      changed();
    },
    clearSearch() { z.search = {q: '', busy: false, results: null, error: null}; changed(); },
    /** A found place: the map goes there and a new zone is drafted on it, named after its first part. */
    choose(result) {
      if (!z.canWrite) return z.look({latitude: result.latitude, longitude: result.longitude});
      if (z.dirty() && z.selected !== 'new') return z.say(`Save or cancel the changes to ${zoneName(z.zone(z.selected))} first`, true);
      z.place(result.latitude, result.longitude, String(result.name ?? '').split(',')[0].trim());
      z.search = {...z.search, results: null};
      z.look({latitude: result.latitude, longitude: result.longitude});
    },
  };
  return z;
}
