import {timeText} from './quantity.js';
import {createNeeds, needsFor, needOrigin} from './needs.js';
import {habitatClient} from './habitat.js';
import {describeFailure} from './failure.js';
// The House page (contract/house.md *House*): Habitat's entities, states, rules and needs through the host's backend registry (`habitat.*`
// ops; its state stream as `habitat.state` events), no DOM. What the tablet, phone and admin views show (status strip, ticker, quick controls, rooms,
// entities, an hourly chart), each control's action, a confirmation before anything that moves hardware (lights and scenes run at
// once), the outcome on the status line.

/** Domains a tap runs at once; every other control (a cover, a lock, a switch) asks first. */
export const DIRECT = new Set(['light', 'scene']);
/** Domains whose changes the ticker lists (a door opened, the garage, a lock, someone home). */
const NOTED = new Set(['binary_sensor', 'cover', 'lock', 'person']);
const OPENING = new Set(['door', 'garage_door', 'opening', 'window']);

/** A list answer, bare or wrapped as `{[key]: list}`. */
const list = (r, key) => Array.isArray(r) ? r : r?.[key] ?? [];

export const domainOf = id => String(id).split('.')[0];
const cap = s => s ? s[0].toUpperCase() + s.slice(1).replaceAll('_', ' ') : s;
/** A house-model room id as a name (`primary-bathroom` → `Primary bathroom`); none: `Other`. */
export const roomName = (area, names = {}) => names[area] ?? (area ? cap(area.replaceAll('-', ' ')) : 'Other');

/** A number with its unit (`61.3°F`, `42 %`); a state that is not a number as is. */
function measure(state, unit) {
  const n = Number(state);
  if (state === '' || !Number.isFinite(n)) return state;
  const v = Math.round(n * 10) / 10;
  return unit ? `${v.toLocaleString('en-US')}${/^°/.test(unit) ? '' : ' '}${unit}` : v.toLocaleString('en-US');
}

/** An entity's state as words: `On · 70%`, `Open`, `Locked`, `Away`, `61.3°F`, `Heat · 69° → 70°`; `Unavailable`, `—` unknown. */
export function stateText(e, s) {
  const st = s?.state, a = {...e?.attributes, ...s?.attributes}, d = e?.domain ?? domainOf(s?.entity_id);
  if (d === 'scene') return 'Scene';
  if (st == null || st === 'unknown' || st === '') return '—';
  if (st === 'unavailable') return 'Unavailable';
  if (d === 'light' && st === 'on' && a.brightness != null) return `On · ${Math.round(a.brightness / 2.55)}%`;
  if (d === 'sensor' && (a.device_class === 'timestamp' || /(?:^|_)next_cycle$/.test(e?.id ?? '') || /next cycle$/i.test(e?.name ?? ''))) {
    const at = typeof st === 'string' ? Date.parse(st) : NaN;
    return Number.isFinite(at) ? timeText(at, {hour: 'numeric', minute: '2-digit'}) : '—';
  }
  if (d === 'sensor') return measure(st, a.unit_of_measurement);
  if (d === 'binary_sensor') return OPENING.has(a.device_class) ? (st === 'on' ? 'Open' : 'Closed')
    : ['motion', 'occupancy', 'presence'].includes(a.device_class) ? (st === 'on' ? 'Detected' : 'Clear') : cap(st);
  if (d === 'person' || d === 'device_tracker') return st === 'home' ? 'Home' : st === 'not_home' ? 'Away' : cap(st);
  if (d === 'climate') return [cap(st), a.current_temperature != null ? `${a.current_temperature}°${a.temperature != null ? ` → ${a.temperature}°` : ''}` : null].filter(Boolean).join(' · ');
  if (d === 'weather') return [a.temperature != null ? `${Math.round(a.temperature)}°` : null, cap(st.replace('partlycloudy', 'partly cloudy'))].filter(Boolean).join(' ');
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
  return {title: e.name, unit: e.attributes?.unit_of_measurement ?? '', valueName: cap(e.attributes?.device_class ?? 'value'), points};
}

/** The outdoor temperature: a temperature sensor outside (area `outside` or none). */
const outdoor = h => h.entities.find(e => e.domain === 'sensor' && e.attributes?.device_class === 'temperature' && (!e.area || e.area === 'outside'));

/** The House on a host whose registry has a habitat backend. opts: `clock` (ms; tests and screenshots fix it), `admin` (rules too), `view` (tablet | phone | admin), `quick` (shown IDs), `chart` (an entity
 *  whose last 24 h the view charts hourly; default the outdoor temperature, null none), `confirmMs` (a confirmation lapses), `outcomeMs` (the status line clears). */
export function createHouse(host, {clock = Date.now, admin = false, view = admin ? 'admin' : 'tablet', quick: quickIds, chart, confirmMs = 8000, outcomeMs = 4000, needsSource = null} = {}) {
  const fns = new Set(), timers = new Set(), offs = [], pending = new Map();
  let needsRead = false;
  let stream, watched = new Set(), patterns, frame = null, stopped = false, connected = false, connection = 0, reported = -1;
  const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? (fn => setTimeout(fn, 16));
  const cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ?? clearTimeout;
  const habitat = habitatClient(host);
  const source = needsSource ?? (host.backends?.includes('habitat') ? needsFor(host) : createNeeds(host, {backends: ['habitat']}));
  const localNeeds = snapshot => snapshot.needs.filter(need => needOrigin(need, need.backend).backend === 'habitat')
    .map(need => ({...need, id: needOrigin(need, need.backend).id}));
  const h = {
    entities: [], byId: new Map(), states: new Map(), rules: null, reports: [], ruleBusy: new Set(), health: null, settings: null, settingBusy: new Set(), needs: [], live: false, lastUpdated: null, loading: true, error: null,
    confirm: null, busy: new Set(), outcome: null, changes: [], chart: null,
    clock, needsSource: source,
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    async start() {
      stopped = false; h.loading = true; connected = false; h.live = false; h.lastUpdated = null; reported = -1;
      offs.push(source.subscribe(() => {
        if (stopped) return;
        h.needs = localNeeds(source); changed();
      }));
      changed();
      offs.push(host.on('habitat.state', d => apply(d)), host.on('habitat.stream', d => {
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
      try {
        const ents = await host.call('habitat.entities', {});
        if (stopped) return;
        const seen = new Set();
        h.quickEntities = list(ents, 'entities').filter(e => !seen.has(e.id) && seen.add(e.id));
        h.entities = h.quickEntities.slice().sort((a, b) => a.name.localeCompare(b.name));
        h.byId = new Map(h.entities.map(e => [e.id, e]));
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
      if (stopped || view !== 'tablet' || h.loading || h.error || !h.live || h.lastUpdated === null || !h.states.size || reported === connection) return;
      reported = connection;
      host.call('habitat.tablet-readiness', {body: {rendered: true, stream_reconnected: true, at: new Date(clock()).toISOString()}})
        .catch(() => {}); // Best effort; the next connection reports fresh evidence.
    },
    watch(next) { view = next.view ?? view; quickIds = next.quick; return watch(); },
    rule(name, mode) {
      const rule = h.rules?.find(r => r.name === name);
      if (!admin || !rule || h.ruleBusy.has(name) || !['live', 'shadow'].includes(mode) ||
          mode === 'live' && (rule.mode !== 'shadow' || !h.reports.find(r => r.rule === name)?.ready)) return;
      const c = h.confirm = {name, mode, verb: mode === 'live' ? 'Cut over' : 'Roll back', rule: true};
      later(() => { if (h.confirm === c) { h.confirm = null; changed(); } }, confirmMs);
      changed();
    },
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
    stop() { stopped = true; patterns = undefined; if (frame !== null) cancelFrame(frame); frame = null; stream?.abort(); for (const off of offs.splice(0)) off(); for (const t of timers) clearTimeout(t); timers.clear(); },
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
    confirmed() { const c = h.confirm; h.confirm = null; changed(); return c ? (c.rule ? runRule(c) : run(c)) : null; },
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
  async function watch() {
    if (stopped || h.loading || h.error) return;
    const id = chart === undefined ? outdoor(h)?.id : chart;
    // Include every input to the visible aggregates, even when its current state hides it.
    const shown = view === 'admin' ? h.entities : [
      ...quick(h, quickIds),
      ...(view === 'phone' ? h.entities.filter(e => e.domain === 'sensor' && ['battery', 'temperature'].includes(e.attributes?.device_class)) : []),
      ...(view === 'phone' ? rooms(h).flatMap(r => r.entities) : []),
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
          for (const s of list(sts, 'states')) if (watched.has(s.entity_id) && !h.states.has(s.entity_id)) h.states.set(s.entity_id, s);
          h.lastUpdated = clock();
          changed();
        } catch (e) { if (!stopped && !controller.signal.aborted) say(describeFailure('Habitat', e).message, true); }
      } else say(describeFailure('Habitat stream', e).message, true);
    }
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
    const id = chart === undefined ? outdoor(h)?.id : chart;
    const needsReady = needsRead ? source.refresh() : source.ensure();
    needsRead = true;
    const [needs, rules, hist] = await Promise.all([
      needsReady,
      admin ? host.call('habitat.rules', {}).catch(e => { say(describeFailure('Habitat', e).message, true); return null; }) : null,
      id && h.byId.has(id) ? host.call('habitat.history', {query: {id, since: new Date(clock() - 24 * 3600000).toISOString()}}).catch(e => { say(describeFailure('Habitat', e).message, true); return null; }) : null,
    ]);
    if (admin) {
      try { h.reports = (await host.call('habitat.shadowreport', {query: {days: 7}})).reports ?? []; }
      catch (e) { h.reports = []; say(describeFailure('Habitat', e).message, true); }
    }
    if (admin) await Promise.all(['health', 'settings'].map(async op => {
      try { const r = await host.call(`habitat.${op}`, {}); h[op] = op === 'settings' ? r.settings : r; }
      catch (e) { say(describeFailure('Habitat', e).message, true); }
    }));
    if (needs) h.needs = localNeeds(needs);
    if (rules) h.rules = list(rules, 'rules');
    if (hist) h.chart = hourly(h.byId.get(id), list(hist, 'states'));
    changed();
  }
  function apply({entity_id: id, new: s} = {}) {
    if (stopped || !watched.has(id)) return;
    const old = h.states.get(id);
    if (s) h.states.set(id, s); else h.states.delete(id);
    h.lastUpdated = clock();
    const e = h.byId.get(id), request = pending.get(id);
    if (request && s && old && (old.state !== s.state || e?.domain === 'scene' && old.last_changed !== s.last_changed)
        && !['unknown', 'unavailable'].includes(s.state)) {
      request.observed = s;
      if (request.accepted) confirmState(request);
    }
    if (e && old && s && old.state !== s.state && NOTED.has(e.domain) && s.state !== 'unavailable')
      h.changes = [{entity_id: id, state: s, at: Date.parse(s.last_changed) || clock()}, ...h.changes.filter(c => c.entity_id !== id)].slice(0, 6);
    changed();
  }
  async function runRule(c) {
    h.ruleBusy.add(c.name); changed();
    try {
      await habitat.rule(c.name, c.mode);
      h.rules = list(await habitat.rules(), 'rules');
      h.reports = (await host.call('habitat.shadowreport', {query: {days: 7}})).reports ?? [];
      say('Rule updated');
    } catch (e) { say(describeFailure('Habitat', e).message, true); }
    finally { h.ruleBusy.delete(c.name); changed(); }
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
  if (outside) out.push({id: outside.id, label: 'Outside', value: stateText(outside, h.states.get(outside.id))});
  const people = ofDomain(h, 'person');
  if (people.length) {
    const home = people.filter(p => st(h, p.id) === 'home').map(p => p.name);
    out.push({id: 'people', label: 'Home', value: home.length ? home.join(', ') : 'Nobody'});
  }
  for (const c of ofDomain(h, 'cover').filter(e => attrs(h, e).device_class === 'garage'))
    out.push({id: c.id, label: c.name, value: stateText(c, h.states.get(c.id)), tone: warns(c, h.states.get(c.id)) ? 'warn' : 'ok'});
  const locks = ofDomain(h, 'lock'), open = locks.filter(l => warns(l, h.states.get(l.id)));
  if (locks.length) out.push({id: 'locks', label: 'Locks', value: open.length ? open.map(l => `${l.name} ${stateText(l, h.states.get(l.id)).toLowerCase()}`).join(', ') : 'All locked', tone: open.length ? 'warn' : 'ok'});
  const doors = h.entities.filter(e => e.domain === 'binary_sensor' && OPENING.has(attrs(h, e).device_class) && st(h, e.id) === 'on');
  if (doors.length) out.push({id: 'doors', label: 'Open', value: doors.map(d => d.name).join(', '), tone: 'warn'});
  for (const c of ofDomain(h, 'climate')) out.push({id: c.id, label: c.name, value: stateText(c, h.states.get(c.id))});
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

/** Quick controls: `ids` in order (the owner's most used), else scenes, covers, locks, then lights by room. */
export function quick(h, ids = null) {
  const source = h.quickEntities ?? h.entities;
  const unique = items => { const seen = new Set(); return items.filter(e => e && !seen.has(e.id) && seen.add(e.id)); };
  if (ids) return unique(ids.map(id => source.find(e => e.id === id)));
  const by = d => source.filter(e => e.domain === d);
  return unique([...by('scene'), ...by('cover'), ...by('lock'), ...by('light').sort((a, b) => (a.area ?? '~').localeCompare(b.area ?? '~') || a.name.localeCompare(b.name))]);
}

/** Rooms by name, each its entities with a control or a reading (no cameras, scenes, people or the weather): [{area, name, entities}]. */
export function rooms(h, names = {}) {
  const by = new Map();
  // HA's Identify and Clear Hold buttons share the climate entity's device; admin keeps them available.
  const thermostats = new Set(h.entities.filter(e => e.domain === 'climate' && e.device).map(e => e.device));
  for (const e of h.entities) {
    if (['camera', 'scene', 'weather', 'person'].includes(e.domain)) continue;
    if (e.device && thermostats.has(e.device) && e.domain === 'button') continue;
    // Presence is significant: null is an authoritative unassigned HA area.
    const area = Object.hasOwn(e, 'ha_area') ? e.ha_area?.id ?? null : e.area ?? null;
    const name = Object.hasOwn(e, 'ha_area') ? e.ha_area?.name : undefined;
    const group = by.get(area) ?? by.set(area, {name, entities: []}).get(area);
    group.entities.push(e);
  }
  return [...by].map(([area, group]) => ({area, name: group.name ?? roomName(area, names), entities: group.entities})).sort((a, b) => (a.area == null) - (b.area == null) || a.name.localeCompare(b.name));
}

/** The admin's entities: `q` in the name or id, `domain` one; unavailable first, then by id. */
export function entities(h, {q = '', domain = null} = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return h.entities.filter(e => (!domain || e.domain === domain) && words.every(w => e.name.toLowerCase().includes(w) || e.id.includes(w)))
    .sort((a, b) => (st(h, b.id) === 'unavailable') - (st(h, a.id) === 'unavailable') || a.id.localeCompare(b.id));
}

/** Sparse device readings: only finite battery/temperature states, including zero. */
export function readings(h) {
  const rows = new Map();
  for (const e of h.entities) {
    const kind = e.attributes?.device_class, s = h.state(e.id), raw = s?.state;
    if (e.domain !== 'sensor' || !['battery', 'temperature'].includes(kind) || raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw))) continue;
    const id = e.device ?? e.id;
    const row = rows.get(id) ?? {id, name: e.device ? e.device_name ?? e.name : e.name};
    row[kind] ??= {value: Number(raw), unit: s.attributes?.unit_of_measurement ?? e.attributes?.unit_of_measurement ?? (kind === 'battery' ? '%' : '')};
    rows.set(id, row);
  }
  const items = [...rows.values()];
  return {items, columns: ['battery', 'temperature'].filter(key => items.some(row => row[key] != null))};
}
