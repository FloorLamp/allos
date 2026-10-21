import {compareNames} from './names.js';
import {canLink} from './thing-links.js';
import {ago, fieldLabel, joinText, sentence, timeText} from './format.js';
import {formatQuantity} from './quantity.js';
import {createNeeds, needsFor, needOrigin} from './needs.js';
import {describeFailure} from './failure.js';
// The House page (contract/house.md *House*): Habitat's entities, states, rules and needs through the host's backend registry (`habitat.*`
// ops; its state stream as `habitat.state` events), no DOM. What the tablet, phone and admin views show (status strip, ticker, quick controls ranked by use, the phone's search,
// entities, an hourly chart), each control's action, a confirmation before anything that moves hardware (lights and scenes run at
// once), the outcome on the status line.

/** Domains a tap runs at once; every other control (a cover, a lock, a switch) asks first. */
export const DIRECT = new Set(['light', 'scene']);
/** Domains whose changes the ticker lists (a door opened, the garage, a lock, someone home). */
const NOTED = new Set(['binary_sensor', 'cover', 'lock', 'person']);
const LAWN = 'input_boolean.lawnwork_mode';
const CAMERA_TRIGGERS = {
  'binary_sensor.porch_person_occupancy': 'doorbell',
  'binary_sensor.garage_person_occupancy': 'garage',
  'binary_sensor.any_garage_door_recently_opened': 'garage',
  'binary_sensor.mailbox_door': 'front_yard',
  'binary_sensor.backyard_person_occupancy': 'backyard',
  'binary_sensor.patio_door_contact': 'backyard',
  'binary_sensor.small_patio_door_contact': 'backyard',
};
const OPENING = new Set(['door', 'garage_door', 'opening', 'window']);
/** The camera wall's views (contract/house.md *Camera wall*): Habitat's `wall` entities and the cameras' media alone. */
export const WALL_VIEWS = new Set(['wall']);
/** The Cameras place (contract/house.md *Cameras*, `/house/cameras`): every camera and nothing else, for a signed-in member. */
export const CAMERAS_VIEW = 'cameras';
/** Domains a tile controls (control()): the House page's grid and its search. */
export const CONTROLLED = new Set(['light', 'switch', 'fan', 'scene', 'cover', 'lock']);
const USAGE_MS = 3600000; // Habitat recomputes its ranking at most hourly (habitat docs/contract/house-usage.md)

/** A list answer, bare or wrapped as `{[key]: list}`. */
const list = (r, key) => Array.isArray(r) ? r : r?.[key] ?? [];

export const domainOf = id => String(id).split('.')[0];
const cap = s => s ? fieldLabel(s) : s;
/** A house-model room id as a name (`primary-bathroom` → `Primary bathroom`); none: `Other`. */
export const roomName = (area, names = {}) => names[area] ?? (area ? cap(area.replaceAll('-', ' ')) : 'Other');

/** A number with its unit (`61.3°F`, `42 %`); a state that is not a number as is. */
function measure(state, unit) {
  const n = Number(state);
  if (state === '' || !Number.isFinite(n)) return state;
  const v = Math.round(n * 10) / 10;
  const text = formatQuantity({value: v, precision: Number.isInteger(v) ? 0 : 1});
  return unit ? `${text}${/^°/.test(unit) ? '' : ' '}${unit}` : text;
}

/** A temperature unit as Home Assistant reports it: a weather's `temperature_unit`, else a `unit_of_measurement` (°C, °F). */
const degrees = a => [a?.temperature_unit, a?.unit_of_measurement].find(u => /^°[CF]$/.test(u ?? '')) ?? null;
/** The house's temperature unit, for readings with none of their own (HA's thermostats): its weather's; null when unknown. */
export const temperatureUnit = h => {
  const w = h.entities.find(e => e.domain === 'weather');
  return w ? degrees({...w.attributes, ...h.states.get(w.id)?.attributes}) : null;
};

/** An entity's state as words: `On · 70%`, `Open`, `Locked`, `Away`, `61.3°F`, `Heat · 20.3°C → 21°C`; `Unavailable`, `—` unknown.
 *  `unit`: the house's temperature unit where the entity names none (temperatureUnit); never converted, `°` alone when unknown. */
export function stateText(e, s, {unit = null} = {}) {
  const st = s?.state, a = {...e?.attributes, ...s?.attributes}, d = e?.domain ?? domainOf(s?.entity_id);
  if (d === 'scene') return 'Scene';
  if (st == null || st === 'unknown' || st === '') return '—';
  if (st === 'unavailable') return 'Unavailable';
  if (d === 'light' && st === 'on' && a.brightness != null) return `On · ${Math.round(a.brightness / 2.55)}%`;
  if (d === 'sensor' && (a.device_class === 'timestamp' || /(?:^|_)next_cycle$/.test(e?.id ?? '') || /next cycle$/i.test(e?.name ?? ''))) {
    const at = typeof st === 'string' ? Date.parse(st) : NaN;
    return Number.isFinite(at) ? timeText(at) : '—';
  }
  if (d === 'sensor') return measure(st, a.unit_of_measurement);
  if (d === 'binary_sensor') return OPENING.has(a.device_class) ? (st === 'on' ? 'Open' : 'Closed')
    : ['motion', 'occupancy', 'presence'].includes(a.device_class) ? (st === 'on' ? 'Detected' : 'Clear') : cap(st);
  if (d === 'person' || d === 'device_tracker') return st === 'home' ? 'Home' : st === 'not_home' ? 'Away' : cap(st);
  const deg = degrees(a) ?? unit ?? '°';
  if (d === 'climate') return [cap(st), a.current_temperature != null ? (a.temperature != null ? `${a.current_temperature}${deg} → ${a.temperature}${deg}` : `${a.current_temperature}${deg}`) : null].filter(Boolean).join(' · ');
  if (d === 'weather') return [a.temperature != null ? `${Math.round(a.temperature)}${deg}` : null, cap(st.replace('partlycloudy', 'partly cloudy').replace('clear-night', 'clear night'))].filter(Boolean).join(' ');
  return cap(st);
}

/** What a tap does to an entity: {entity_id, action, verb, on, direct, disabled}; null for one with no control (a sensor). */
export function control(e, s) {
  const st = s?.state ?? 'unknown', d = e.domain, disabled = st === 'unavailable';
  const c = (action, verb, on = false) => ({entity_id: e.id, name: e.name, action, verb, on, direct: DIRECT.has(d), disabled});
  if (d === 'light' || d === 'switch' || d === 'fan') return st === 'on' ? c(`${d}.turn_off`, 'Turn off', true) : c(`${d}.turn_on`, 'Turn on');
  if (d === 'scene') return c('scene.turn_on', 'Run');
  if (d === 'cover') return ['open', 'opening'].includes(st) ? c('cover.close_cover', 'Close', true) : c('cover.open_cover', 'Open');
  if (d === 'lock') return st === 'locked' ? c('lock.unlock', 'Unlock') : c('lock.lock', 'Lock', true);
  return null;
}

/** Whether an entity is in a state worth a warning: a door or garage open, a lock unlocked or jammed, unavailable. */
export function warns(e, s) {
  const st = s?.state, a = {...e.attributes, ...s?.attributes};
  return st === 'unavailable' || (e.domain === 'lock' && st !== 'locked') || (e.domain === 'cover' && st !== 'closed')
    || (e.domain === 'binary_sensor' && OPENING.has(a.device_class) && st === 'on');
}

/** Hourly means (UTC hours, the chart's `YYYY-MM-DDTHH`) of a numeric entity's history: deck/ui's Chart data. */
export function hourly(e, states) {
  const bins = new Map();
  for (const s of states ?? []) {
    const v = Number(s.state), t = new Date(s.last_changed ?? s.last_updated);
    if (s.state === '' || !Number.isFinite(v) || Number.isNaN(t.getTime())) continue;
    const k = t.toISOString().slice(0, 13);
    const b = bins.get(k) ?? bins.set(k, [0, 0]).get(k);
    b[0] += v; b[1]++;
  }
  const points = [...bins].sort(([a], [b]) => a < b ? -1 : 1).map(([period, [sum, n]]) => ({period, value: Math.round(sum / n * 10) / 10}));
  // a temperature has no meaningful zero: its axis spans the readings
  // the unit the readings were reported in (the latest state's, else the entity's), never converted
  const unit = [...(states ?? [])].reverse().find(s => s.attributes?.unit_of_measurement)?.attributes.unit_of_measurement ?? e.attributes?.unit_of_measurement ?? '';
  return {title: e.name, unit, valueName: cap(e.attributes?.device_class ?? 'value'), points,
    ...(e.attributes?.device_class === 'temperature' ? {zero: false} : {})};
}

/** The outdoor temperature: a temperature sensor outside (area `outside` or none). */
const outdoor = h => h.entities.find(e => e.domain === 'sensor' && e.attributes?.device_class === 'temperature' && (!e.area || e.area === 'outside'));

/** The House on a host whose registry has a habitat backend. opts: `clock` (ms; tests and screenshots fix it), `admin` (rules too), `view` (tablet | phone | cameras | admin), `quick` (shown IDs), `chart` (an entity
 *  whose last 24 h the view charts hourly; default the outdoor temperature, null none), `confirmMs` (a confirmation lapses), `outcomeMs` (the status line clears),
 *  `member` (Habitat's `/api/member`: null for a display nobody signed in to, which reads no Habitat Needs; `read_only` the agent
 *  member, which reports no tablet readiness; omitted: unknown, Habitat decides). `view` `thing` (a thing's page, contract/things.md
 *  *Hub*): `entities` (Habitat's shape: {id, domain, name, attributes}) and their `states` are the thing's linked devices', read from
 *  bridge, so no entity list, Needs, usage or chart is read; only they are watched, and where the host has no stream, a read of the
 *  states stands for it (live as of that read; a sent action reads them again). */
export function createHouse(host, {clock = Date.now, admin = false, view = admin ? 'admin' : 'tablet', quick: quickIds, chart, confirmMs = 8000, outcomeMs = 4000, needsSource = null, member,
  entities: seeded = null, states: seedStates = []} = {}) {
  const fns = new Set(), timers = new Set(), offs = [], pending = new Map();
  const thing = view === 'thing';
  let needsRead = false, focusTimer = null, polled = false;
  // Habitat answers its Needs to a member only, and takes readiness (a write) from one who may write.
  const readsNeeds = !thing && (!!needsSource || member !== null), readiness = member !== null && !member?.read_only;
  let stream, watched = new Set(), patterns, frame = null, stopped = false, connected = false, connection = 0, reported = -1;
  const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? (fn => setTimeout(fn, 16));
  const cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ?? clearTimeout;
  const source = thing ? null : needsSource ?? (host.backends?.includes('habitat') ? needsFor(host) : createNeeds(host, {backends: ['habitat']}));
  const localNeeds = snapshot => snapshot.needs.filter(need => needOrigin(need, need.backend).backend === 'habitat')
    .map(need => ({...need, id: needOrigin(need, need.backend).id}));
  const h = {
    entities: [], byId: new Map(), states: new Map(), usage: [], rules: null, health: null, settings: null, settingBusy: new Set(), needs: [], live: false, lastUpdated: null, loading: true, error: null,
    cameraFocus: null, confirm: null, busy: new Set(), outcome: null, changes: [], chart: null,
    clock, needsSource: source,
    /** May this member link a device to a thing (bridge's write; the page's member and Habitat's: neither the agent member)? */
    linksThings: canLink(host) && member !== null && !member?.read_only,
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    async start() {
      stopped = false; h.loading = true; connected = false; h.live = false; h.lastUpdated = null; reported = -1;
      if (source) offs.push(source.subscribe(() => {
        if (stopped) return;
        h.needs = localNeeds(source); changed();
      }));
      changed();
      offs.push(host.on('habitat.state', d => apply(d, true)), host.on('habitat.stream', d => {
        const back = d?.live && !h.live && connected;
        if (d?.live && !h.live) connection++;
        if (d?.live) connected = true;
        h.live = !!d?.live;
        if (!h.live) h.confirm = null;
        if (back) { readStates(); refresh(); }
        changed();
      }));
      const doc = globalThis.document;
      const visible = () => { if (doc.visibilityState === 'visible' && !h.loading) { readStates(); refresh(); } };
      doc?.addEventListener('visibilitychange', visible);
      offs.push(() => doc?.removeEventListener('visibilitychange', visible));
      if (view !== 'admin' && view !== CAMERAS_VIEW && !WALL_VIEWS.has(view) && !thing) readUsage();
      try {
        const ents = seeded ?? await host.call('habitat.entities', {});
        if (stopped) return;
        const seen = new Set();
        h.quickEntities = list(ents, 'entities').filter(e => !seen.has(e.id) && seen.add(e.id));
        h.entities = h.quickEntities.slice().sort((a, b) => compareNames(a.name, b.name));
        h.byId = new Map(h.entities.map(e => [e.id, e]));
        for (const s of seedStates) if (s?.entity_id && h.byId.has(s.entity_id)) h.states.set(s.entity_id, s);
      } catch (e) {
        h.error = e;
      }
      h.loading = false;
      changed();
      if (h.error) return;
      await watch();
      if (!stopped) await refresh();
    },
    /** Called by the view only after its DOM commit, never by connection or data callbacks. */
    rendered() {
      if (stopped || !readiness || view !== 'tablet' || h.loading || h.error || !h.live || h.lastUpdated === null || !h.states.size || reported === connection) return;
      reported = connection;
      host.call('habitat.tablet-readiness', {body: {rendered: true, stream_reconnected: true, at: new Date(clock()).toISOString()}})
        .catch(() => {}); // Best effort; the next connection reports fresh evidence.
    },
    watch(next) { view = next.view ?? view; quickIds = next.quick; return watch(); },
    async setting(name, value) {
      if (!admin || !h.settings?.[name] || h.settingBusy.has(name)) return;
      h.settingBusy.add(name); changed();
      try {
        await host.call('habitat.setting', {query: {name}, body: {value}});
        h.settings = (await host.call('habitat.settings', {})).settings;
        say('Saved');
      } catch (e) { say(describeFailure('Habitat', e).message, true); }
      finally { h.settingBusy.delete(name); changed(); }
    },
    stop() { clearFocus(); stopped = true; patterns = undefined; if (frame !== null) cancelFrame(frame); frame = null; stream?.abort(); for (const off of offs.splice(0)) off(); for (const t of timers) clearTimeout(t); timers.clear(); },
    entity: id => h.byId.get(id),
    state: id => h.states.get(id),
    /** A tap on an entity's control: lights and scenes run; anything else waits for confirm(). */
    act(id) {
      const e = h.byId.get(id), c = e && control(e, h.states.get(id));
      if (!h.live || !c || c.disabled || h.busy.has(id)) return null;
      if (c.direct) return run(c);
      h.confirm = c;
      later(() => { if (h.confirm === c) { h.confirm = null; changed(); } }, confirmMs);
      changed();
      return null;
    },
    confirmed() { const c = h.confirm; h.confirm = null; changed(); return c ? run(c) : null; },
    cancel() { if (h.confirm) { h.confirm = null; changed(); } },
    /** Repair a need or update its acknowledgement, resolution or snooze through Habitat. */
    async need(id, op) {
      try {
        const r = await host.call('habitat.need', {query: {id}, body: {id, ...(op ? {op} : {}), ...(op === 'snooze' ? {until: new Date(clock() + 3600000).toISOString()} : {})}});
        say(r?.ok ? (r.message ?? 'Done') : describeFailure('Habitat', {code: 'http'}).message, !r?.ok);
      } catch (e) { say(describeFailure('Habitat', e).message, true); }
      await source.refresh({force: true});
    },
  };
  function changed() {
    if (stopped || frame !== null) return;
    frame = requestFrame(() => { frame = null; if (!stopped) for (const fn of fns) fn(h); });
  }
  // the hourly chart's entity (the tablet's): the configured one, else the outdoor temperature; the wall and the phone chart nothing
  const chartId = () => WALL_VIEWS.has(view) || view === 'phone' || view === CAMERAS_VIEW || thing ? null : chart === undefined ? outdoor(h)?.id : chart;
  async function watch() {
    if (stopped || h.loading || h.error) return;
    const id = chartId();
    // Include every input to the visible aggregates, even when its current state hides it.
    const shown = view === 'admin' || thing ? h.entities : WALL_VIEWS.has(view) ? h.entities.filter(e => e.attributes?.wall)
      : view === CAMERAS_VIEW ? h.entities.filter(e => e.domain === 'camera') : [
      ...quick(h, quickIds),
      ...(view === 'tablet' ? h.entities.filter(e => e.id === LAWN || Object.hasOwn(CAMERA_TRIGGERS, e.id)) : []),
      // the phone's search toggles any control at once: every control's state is at hand
      ...(view === 'phone' ? h.entities.filter(e => CONTROLLED.has(e.domain)) : []),
      ...h.entities.filter(e => ['camera', 'climate', 'light'].includes(e.domain) || NOTED.has(e.domain) || e.attributes?.ticker),
      ...(h.byId.has(id) ? [h.byId.get(id)] : []),
      ...([h.entities.find(e => e.domain === 'weather') ?? outdoor(h)].filter(Boolean)),
    ];
    const ids = new Set(shown.map(e => e.id));
    // One glob per domain keeps the upgrade URL bounded even for a mirrored HA registry.
    // Filter its replay locally: hidden entities must not enter the view's state cache.
    const next = [...new Set(shown.map(e => `${domainOf(e.id)}.*`))].sort().join(',');
    const added = [...ids].some(id => !watched.has(id));
    watched = ids;
    for (const id of h.states.keys()) if (!watched.has(id)) h.states.delete(id);
    if (next === patterns && !added) return;
    patterns = next;
    stream?.abort();
    if (!next) return; // An empty patterns argument must never become a wildcard subscription.
    const controller = stream = new AbortController();
    try { await host.call('habitat.stream', {query: {patterns: next}}, {signal: controller.signal}); }
    catch (e) {
      if (stopped || controller.signal.aborted) return;
      if (e.code === 'unsupported') {
        try {
          const sts = await host.call('habitat.states', {}, {signal: controller.signal});
          if (stopped || controller.signal.aborted) return;
          for (const s of list(sts, 'states')) if (watched.has(s.entity_id) && (thing || !h.states.has(s.entity_id))) apply({entity_id: s.entity_id, new: s});
          h.lastUpdated = clock();
          // a thing's page on a host with no stream: its read is the live state, and each sent action reads again
          if (thing) { polled = true; h.live = true; }
          changed();
        } catch (e) { if (!stopped && !controller.signal.aborted) say(describeFailure('Habitat', e).message, true); }
      } else say(describeFailure('Habitat stream', e).message, true);
    }
  }
  /** Habitat's ranking of the controls people use most, again each hour; unread, the quick-control order stands. */
  async function readUsage() {
    try { h.usage = list(await host.call('habitat.usage', {}), 'ranked').map(r => r.entity_id).filter(id => typeof id === 'string'); changed(); }
    catch {} // the page still works in its default order; the next hour tries again
    finally { if (!stopped) later(readUsage, USAGE_MS); }
  }
  function later(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); }
  function say(text, bad = false) {
    const o = h.outcome = {text, bad};
    later(() => { if (h.outcome === o) { h.outcome = null; changed(); } }, outcomeMs);
    changed();
  }
  async function readStates() {
    const controller = stream, before = new Map(h.states);
    if (!watched.size || stopped) return;
    try {
      const result = await host.call('habitat.states', {}, {signal: controller?.signal});
      if (stopped || controller !== stream || controller?.signal.aborted) return;
      const states = new Map(list(result, 'states').map(s => [s.entity_id, s]));
      for (const id of watched) {
        // A stream event received during the read is newer than the snapshot.
        if (h.states.get(id) !== before.get(id)) continue;
        apply({entity_id: id, new: states.get(id)});
      }
      h.lastUpdated = clock();
      changed();
    } catch (e) { if (!stopped && !controller?.signal.aborted) say(describeFailure('Habitat', e).message, true); }
  }
  async function refresh() {
    const id = chartId();
    const needsReady = !readsNeeds ? null : needsRead ? source.refresh() : source.ensure();
    needsRead = true;
    const [needs, rules, hist] = await Promise.all([
      needsReady,
      admin ? host.call('habitat.rules', {}).catch(e => { say(describeFailure('Habitat', e).message, true); return null; }) : null,
      id && h.byId.has(id) ? host.call('habitat.history', {query: {id, since: new Date(clock() - 24 * 3600000).toISOString()}}).catch(e => { say(describeFailure('Habitat', e).message, true); return null; }) : null,
    ]);
    if (admin) await Promise.all(['health', 'settings'].map(async op => {
      try { const r = await host.call(`habitat.${op}`, {}); h[op] = op === 'settings' ? r.settings : r; }
      catch (e) { say(describeFailure('Habitat', e).message, true); }
    }));
    if (needs) h.needs = localNeeds(needs);
    if (rules) h.rules = list(rules, 'rules');
    if (hist) h.chart = hourly(h.byId.get(id), list(hist, 'states'));
    changed();
  }
  function clearFocus() {
    if (focusTimer !== null) { clearTimeout(focusTimer); timers.delete(focusTimer); focusTimer = null; }
    h.cameraFocus = null;
  }
  function focusCamera(id) {
    if (!h.byId.has(id)) return;
    clearFocus();
    h.cameraFocus = id;
    focusTimer = setTimeout(() => { timers.delete(focusTimer); focusTimer = null; h.cameraFocus = null; changed(); }, 600000);
    timers.add(focusTimer);
  }
  function apply({entity_id: id, new: s} = {}, event = false) {
    if (stopped || !watched.has(id)) return;
    const old = h.states.get(id);
    if (s) h.states.set(id, s); else h.states.delete(id);
    h.lastUpdated = clock();
    const e = h.byId.get(id), request = pending.get(id);
    if (view === 'tablet') {
      if (h.states.get(LAWN)?.state === 'on') {
        clearFocus();
        if (h.byId.has('camera.front_yard')) h.cameraFocus = 'camera.front_yard';
      } else if (id === LAWN && old?.state === 'on') clearFocus();
      else if (event && old && s && !['unknown', 'unavailable'].includes(s.state)) {
        if (e?.domain === 'camera' && e.driver === 'frigate' && JSON.stringify(old) !== JSON.stringify(s)) focusCamera(id);
        else if (CAMERA_TRIGGERS[id] && s.state === 'on' && old.state !== 'on') focusCamera(`camera.${CAMERA_TRIGGERS[id]}`);
      }
    }
    if (request && s && old && (old.state !== s.state || e?.domain === 'scene' && old.last_changed !== s.last_changed)
        && !['unknown', 'unavailable'].includes(s.state)) {
      request.observed = s;
      if (request.accepted) confirmState(request);
    }
    if (e && old && s && old.state !== s.state && NOTED.has(e.domain) && s.state !== 'unavailable')
      h.changes = [{entity_id: id, state: s, at: Date.parse(s.last_changed) || clock()}, ...h.changes.filter(c => c.entity_id !== id)].slice(0, 6);
    changed();
  }
  function confirmState(request) {
    pending.delete(request.entity_id);
    h.busy.delete(request.entity_id);
    say(`${request.name}: ${stateText(h.entity(request.entity_id), request.observed)}`);
  }
  async function run(c) {
    if (!h.live) return null;
    const request = {...c, accepted: false, observed: null};
    pending.set(c.entity_id, request);
    h.busy.add(c.entity_id);
    changed();
    let r = null, err = null;
    try { r = await host.call('habitat.act', {body: {action: c.action, target: {entity_id: [c.entity_id]}}}); } catch (e) { err = e; }
    if (err || !r?.ok) {
      pending.delete(c.entity_id);
      h.busy.delete(c.entity_id);
      say(describeFailure('Habitat', err ?? {code: 'http'}).message, true);
    } else {
      say(`Sent: ${c.name}${r.shadow ? ' (recorded in shadow)' : ''}`);
      if (r.shadow) {
        pending.delete(c.entity_id);
        h.busy.delete(c.entity_id);
        changed();
      } else {
        request.accepted = true;
        if (request.observed) confirmState(request);
        else if (polled) later(readStates, 1500);
        later(() => {
          if (pending.get(c.entity_id) !== request) return;
          pending.delete(c.entity_id);
          h.busy.delete(c.entity_id);
          say(`${c.name} did not respond`, true);
        }, 10000);
      }
    }
    return r;
  }
  return h;
}

const ofDomain = (h, d) => h.entities.filter(e => e.domain === d);
const st = (h, id) => h.states.get(id)?.state;
const attrs = (h, e) => ({...e.attributes, ...h.states.get(e.id)?.attributes});

/** The tablet's status strip: [{id, label, value, tone?}]: outside, people home, the garage, locks, open doors, climate, lights on, needs. */
export function status(h) {
  const out = [];
  const weather = ofDomain(h, 'weather')[0];
  const outside = weather ?? outdoor(h);
  const unit = temperatureUnit(h);
  if (outside) out.push({id: outside.id, label: 'Outside', value: stateText(outside, h.states.get(outside.id), {unit})});
  const people = ofDomain(h, 'person');
  if (people.length) {
    const home = people.filter(p => st(h, p.id) === 'home').map(p => p.name);
    out.push({id: 'people', label: 'Home', value: home.length ? home.join(', ') : 'Nobody'});
  }
  // Several garages, locks or open doors are one figure each: a count once more than one needs a look, so the strip keeps every figure whole.
  const garages = ofDomain(h, 'cover').filter(e => attrs(h, e).device_class === 'garage'), ajar = garages.filter(c => warns(c, h.states.get(c.id)));
  if (garages.length === 1) { const [c] = garages; out.push({id: c.id, label: c.name, value: stateText(c, h.states.get(c.id)), tone: ajar.length ? 'warn' : 'ok'}); }
  else if (garages.length) out.push({id: 'garages', label: 'Garage', tone: ajar.length ? 'warn' : 'ok',
    value: !ajar.length ? 'All closed' : ajar.length === 1 ? `${ajar[0].name} ${stateText(ajar[0], h.states.get(ajar[0].id)).toLowerCase()}` : `${ajar.length} open`});
  const locks = ofDomain(h, 'lock'), open = locks.filter(l => warns(l, h.states.get(l.id)));
  if (locks.length) out.push({id: 'locks', label: 'Locks', tone: open.length ? 'warn' : 'ok',
    value: !open.length ? 'All locked' : open.length === 1 ? `${open[0].name} ${stateText(open[0], h.states.get(open[0].id)).toLowerCase()}` : `${open.length} unlocked`});
  const doors = h.entities.filter(e => e.domain === 'binary_sensor' && OPENING.has(attrs(h, e).device_class) && st(h, e.id) === 'on');
  if (doors.length) out.push({id: 'doors', label: 'Open', value: doors.length === 1 ? doors[0].name : `${doors.length} doors and windows`, tone: 'warn'});
  for (const c of ofDomain(h, 'climate')) out.push({id: c.id, label: c.name, value: stateText(c, h.states.get(c.id), {unit})});
  const lights = ofDomain(h, 'light').filter(l => st(h, l.id) === 'on').length;
  out.push({id: 'lights', label: 'Lights', value: lights ? `${lights} on` : 'All off'});
  const needCount = h.needsSource?.count ?? h.needs.length;
  if (needCount) out.push({id: 'needs', label: 'Needs you', value: String(needCount), tone: 'warn'});
  return out;
}

/** The ticker: what the house says now (entities whose attributes say `ticker: true`, a line each while they have one), then the
 *  latest changes the stream brought (a door, the garage, a lock, someone home), newest first. [{id, text, at?}] */
export function ticker(h) {
  const said = h.entities.filter(e => e.attributes?.ticker && !['', 'off', 'unknown', 'unavailable', 'idle', 'none'].includes(st(h, e.id) ?? ''))
    .map(e => ({id: e.id, text: `${e.name}: ${stateText(e, h.states.get(e.id))}`}));
  const seen = h.changes.map(c => { const e = h.byId.get(c.entity_id); return {id: `change:${c.entity_id}`, text: `${e.name} ${stateText(e, c.state).toLowerCase()}`, at: c.at}; });
  return [...said, ...seen];
}

/** The band's delivery (contract/house.md *Delivery map*) while both its points are places on Earth, else null. */
const place = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
export const deliveryOf = d => d && typeof d === 'object' && place(d.dasher) && place(d.home) ? d : null;

/** The camera wall (contract/house.md *Camera wall*): Habitat's `wall: band` and `wall: cameras` entities' states as
 *  {weather, chips, ticker, delivery, cameras}; empty until Habitat publishes them. */
export function wall(h) {
  const of = kind => { const e = h.entities.find(x => x.attributes?.wall === kind); return (e && h.states.get(e.id)?.attributes) ?? {}; };
  const band = of('band'), {cameras = []} = of('cameras');
  return {weather: band.weather ?? null, chips: Array.isArray(band.chips) ? band.chips : [], ticker: band.ticker ?? null,
    delivery: deliveryOf(band.delivery), cameras: Array.isArray(cameras) ? cameras : []};
}

/** Quick controls: `ids` in order (configured), else the controls people use most (Habitat's `usage` ranking), then the rest as
 *  scenes, covers, locks, then lights by room (also the whole order while there is no history). */
export function quick(h, ids = null) {
  const source = h.quickEntities ?? h.entities, byId = new Map(source.map(e => [e.id, e]));
  const unique = items => { const seen = new Set(); return items.filter(e => e && !seen.has(e.id) && seen.add(e.id)); };
  if (ids) return unique(ids.map(id => byId.get(id)));
  const by = d => source.filter(e => e.domain === d);
  return unique([...(h.usage ?? []).map(id => byId.get(id)).filter(e => e && CONTROLLED.has(e.domain)),
    ...by('scene'), ...by('cover'), ...by('lock'), ...by('light').sort((a, b) => compareNames(a.area ?? '~', b.area ?? '~') || compareNames(a.name, b.name))]);
}

/** A control's room as its tile and search name it: HA's area (authoritative when present), else house-model's. */
export function roomOf(e, names = {}) {
  if (Object.hasOwn(e, 'ha_area')) return e.ha_area?.name ?? null;
  return e.area ? roomName(e.area, names) : null;
}

/** The House page's search over every control: what a person might type for it (name, room, HA's aliases, its kind). */
export function controls(h, names = {}) {
  return (h.quickEntities ?? h.entities).filter(e => CONTROLLED.has(e.domain))
    .map(e => ({e, text: [e.name, roomOf(e, names), ...(Array.isArray(e.attributes?.aliases) ? e.attributes.aliases : []), e.domain].filter(Boolean).join(' ')}));
}

/** The admin's entities: `q` in the name or id, `domain` one; unavailable first, then by id. */
export function entities(h, {q = '', domain = null} = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return h.entities.filter(e => (!domain || e.domain === domain) && words.every(w => e.name.toLowerCase().includes(w) || e.id.includes(w)))
    .sort((a, b) => (st(h, b.id) === 'unavailable') - (st(h, a.id) === 'unavailable') || a.id.localeCompare(b.id));
}

/** A Habitat service (a `habitat.health` driver) by its name: `ha` → `Home Assistant`, `ha_energy_statistics` → `Home Assistant energy
 *  statistics`. */
const SERVICES = {ha: 'Home Assistant', z2m: 'Zigbee2MQTT', zigbee: 'Zigbee', frigate: 'Frigate', habitat: 'Habitat', houston: 'Houston', trmnl: 'TRMNL'};
export function serviceName(name) {
  const [head, ...rest] = String(name).split('_');
  if (SERVICES[name]) return SERVICES[name];
  return SERVICES[head] && rest.length ? `${SERVICES[head]} ${fieldLabel(rest.join('_')).toLowerCase()}` : fieldLabel(name);
}

const PAIR = /^([\w ]+?)\s*=\s*(.*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** One fact of a service in words: `connected=True` → `Connected`, `False` → `Not connected`, `availability=online` → `Online`, a time →
 *  `Last stats 5 min ago`; nothing for an empty one. */
function factText(key, value, now) {
  const v = String(value ?? '').trim(), words = fieldLabel(key);
  if (!v || /^(none|null|unknown)$/i.test(v)) return null;
  if (/^true$/i.test(v)) return words;
  if (/^false$/i.test(v)) return `Not ${words.toLowerCase()}`;
  if (/^(availability|state|status)$/i.test(key.trim())) return sentence(v);
  if (ISO.test(v)) return `${words} ${ago(v, now)}`;
  return `${words} ${v}`;
}

/** A service's one line: its detail in words (Habitat's `key=value; …` read out, `HA` named), its other facts, since when it is
 *  stale; unknowns left out. */
export function serviceLine(driver = {}, now = Date.now()) {
  const detail = String(driver.detail ?? '').trim(), parts = detail.split(/;\s*/);
  const said = !detail ? null : parts.every(p => PAIR.test(p)) ? joinText(parts.map(p => factText(...PAIR.exec(p).slice(1), now)))
    : sentence(detail.replace(/\bHA\b/g, 'Home Assistant'));
  const facts = Object.entries(driver).filter(([key, value]) => !['ok', 'detail', 'stale_since', 'checks'].includes(key) && value != null && typeof value !== 'object')
    .map(([key, value]) => factText(key, value, now));
  return joinText([said, ...facts, driver.stale_since ? `Stale since ${ago(driver.stale_since, now)}` : null]) || null;
}

/** A service's failing checks as notes: [{text: `Coordinator reads: No coordinator response`, tone: 'warn'}]. */
export const serviceNotes = (driver = {}) => Object.entries(driver.checks ?? {}).filter(([, check]) => check?.ok === false)
  .map(([name, check]) => ({text: joinText([fieldLabel(name), check.detail ? sentence(check.detail) : null], ': '), tone: 'warn'}));

