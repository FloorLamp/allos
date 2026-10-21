// Zigbee reconnect (contract/house.md *Admin pages*; habitat docs/contract/zigbee-reconnect.md): every Zigbee device by area,
// offline first, what to do for one that is offline, the activity feed and the owner's permit-join, no DOM. Its `transport` is the
// host's (web/house-zigbee.js: Habitat's /api/zigbee, its stream's `sensor.zigbee_reconnect`, POST /api/zigbee/permit). Unknowns are left
// out (sleeping is not offline). view/house-zigbee.js draws it.
import {age, ago, dateTimeText, fieldLabel, joinText, plural, sentence} from './format.js';

/** A device's name as people read it: Zigbee2MQTT's friendly name, a slug in words (`kitchen_lamp` → `Kitchen lamp`). */
export const deviceName = name => /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(String(name ?? '')) && !/^0x[0-9a-f]+$/i.test(name) ? fieldLabel(name) : String(name ?? '');

/** A device as a row, under its area: its model, power (a battery's level and type when Zigbee2MQTT says), when it went offline or
 *  was last seen; offline ones say so and what to do. */
export function deviceRow(d, {now = Date.now()} = {}) {
  const offline = d.availability === 'offline', battery = d.power === 'Battery';
  const power = battery ? joinText([d.battery != null ? `Battery ${d.battery}%` : 'Battery', d.battery_type ? `(${d.battery_type})` : null], ' ')
    : d.power ? sentence(d.power) : null;
  return {id: d.name, glyph: battery ? 'battery' : 'plug', title: deviceName(d.name), section: {key: d.area, label: d.area},
    sub: joinText([d.model, power, offline && d.since ? `Offline since ${dateTimeText(d.since, {now})}` : d.last_seen != null ? `Seen ${ago(d.last_seen, now)}` : null]),
    summary: offline ? d.hint ?? null : null,
    badge: offline ? {text: 'Offline', tone: 'warn'} : d.availability === 'online' ? {text: 'Online', tone: 'ok'} : null};
}

/** Every device's rows: areas by name, each offline first then by name. */
export function deviceRows(snapshot, opts = {}) {
  return [...snapshot?.devices ?? []].sort((a, b) => String(a.area).localeCompare(String(b.area))
    || Number(b.availability === 'offline') - Number(a.availability === 'offline') || deviceName(a.name).localeCompare(deviceName(b.name)))
    .map(d => deviceRow(d, opts));
}

/** The activity feed as rows: what happened to which device, its detail, how long ago. */
export const feedRows = (snapshot, {now = Date.now()} = {}) => (snapshot?.feed ?? []).map((e, i) => ({id: `${i}:${e.at}`, glyph: 'recent',
  title: joinText([sentence(e.kind), deviceName(e.name)], ': '), sub: e.detail || null, age: e.at != null ? age(e.at, now) : null}));

/** The header's line: how many are offline, whether joining is open (and for how long). */
export function summaryLine(snapshot, {now = Date.now()} = {}) {
  if (!snapshot) return null;
  const offline = (snapshot.devices ?? []).filter(d => d.availability === 'offline').length, end = snapshot.permit_join_end;
  return joinText([`${offline} of ${plural(snapshot.total ?? snapshot.devices?.length ?? 0, 'device')} offline`,
    snapshot.permit_join ? `Joining open${end ? ` for ${Math.max(0, Math.ceil((end - now) / 1000))} s` : ''}` : 'Joining closed']);
}

/** The routers a device may join through, by area then name: [{value, label}], the whole network first. */
export const joinOptions = snapshot => [{value: '', label: 'Whole network'},
  ...[...snapshot?.routers ?? []].sort((a, b) => `${a.area}${a.name}`.localeCompare(`${b.area}${b.name}`)).map(r => ({value: r.name, label: `${r.area} · ${deviceName(r.name)}`}))];

/** The page's model over `transport` ({read(), permit(on, device), stream(onSnapshot, onClose) → close}). opts: `owner` (the join
 *  controls; Habitat refuses anyone else's), `clock`, `retryMs` (the stream reconnects after it). */
export function createZigbee(transport, {owner = false, clock = Date.now, retryMs = 3000} = {}) {
  const listeners = new Set();
  let close = null, retry = null, stopped = false;
  const m = {
    snapshot: null, loading: true, error: null, connected: false, updated: null, owner, clock, via: '', busy: false, note: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async start() {
      m.loading = true; m.error = null; changed();
      try { set(await transport.read()); connect(); }
      catch (e) { m.error = e; }
      finally { m.loading = false; changed(); }
    },
    stop() { stopped = true; clearTimeout(retry); close?.(); },
    choose(via) { m.via = via; changed(); },
    async permit(on) {
      m.busy = true; m.note = null; changed();
      try { await transport.permit(on, m.via || null); m.note = {text: 'Sent; waiting for the coordinator'}; }
      catch (e) { m.note = {text: e.message, bad: true}; }
      finally { m.busy = false; changed(); }
    },
  };
  function set(snapshot) {
    m.snapshot = snapshot; m.updated = clock(); m.error = null;
    if (m.via && !snapshot.routers?.some(r => r.name === m.via)) m.via = '';
    changed();
  }
  function connect() {
    if (stopped) return;
    close = transport.stream(snapshot => { m.connected = true; set(snapshot); }, () => {
      m.connected = false; changed();
      retry = setTimeout(connect, retryMs);
    });
    m.connected = true;
  }
  function changed() { if (!stopped) for (const fn of listeners) fn(); }
  return m;
}
