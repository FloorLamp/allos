// The House place (CONTRACT.md *House*): Habitat's entities, states, rules and needs through the host's backend registry (`habitat.*`
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

/** The House on a host whose registry has a habitat backend. opts: `clock` (ms; tests and screenshots fix it), `admin` (rules too), `chart` (an entity
 *  whose last 24 h the view charts hourly; default the outdoor temperature, null none), `confirmMs` (a confirmation lapses), `outcomeMs` (the status line clears). */
export function createHouse(host, {clock = Date.now, admin = false, chart, confirmMs = 8000, outcomeMs = 4000} = {}) {
  const fns = new Set(), timers = new Set(), offs = [];
  const h = {
    entities: [], byId: new Map(), states: new Map(), rules: null, needs: [], live: false, loading: true, error: null,
    confirm: null, busy: new Set(), outcome: null, changes: [], chart: null,
    clock,
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
    async start() {
      offs.push(host.on('habitat.state', d => apply(d)), host.on('habitat.stream', d => {
        const back = d?.live && !h.live && !h.loading;
        h.live = !!d?.live;
        if (back) refresh();
        changed();
      }));
      try {
        const [ents, sts] = await Promise.all([host.call('habitat.entities', {}), host.call('habitat.states', {})]);
        h.entities = list(ents, 'entities').slice().sort((a, b) => a.name.localeCompare(b.name));
        h.byId = new Map(h.entities.map(e => [e.id, e]));
        for (const s of list(sts, 'states')) if (!h.states.has(s.entity_id)) h.states.set(s.entity_id, s);
      } catch (e) {
        h.error = e?.message ?? String(e);
      }
      h.loading = false;
      changed();
      if (h.error) return;
      host.call('habitat.stream', {query: {patterns: '*'}}).catch(() => {});
      await refresh();
    },
    stop() { for (const off of offs.splice(0)) off(); for (const t of timers) clearTimeout(t); timers.clear(); },
    entity: id => h.byId.get(id),
    state: id => h.states.get(id),
    /** A tap on an entity's control: lights and scenes run; anything else waits for confirm(). */
    act(id) {
      const e = h.byId.get(id), c = e && control(e, h.states.get(id));
      if (!c || c.disabled || h.busy.has(id)) return null;
      if (c.direct) return run(c);
      h.confirm = c;
      later(() => { if (h.confirm === c) { h.confirm = null; changed(); } }, confirmMs);
      changed();
      return null;
    },
    confirmed() { const c = h.confirm; h.confirm = null; changed(); return c ? run(c) : null; },
    cancel() { if (h.confirm) { h.confirm = null; changed(); } },
    /** A need's `op` action (backend/README.md *Needs*), run by Habitat. */
    async need(id) {
      try {
        const r = await host.call('habitat.need', {body: {id}});
        say(r?.message ?? (r?.ok ? 'Done' : 'Failed'), !r?.ok);
      } catch (e) { say(`Couldn’t run it: ${e?.message ?? e}`, true); }
      host.call('habitat.needs', {}).then(r => { h.needs = list(r, 'needs'); changed(); }, () => {});
    },
  };
  function changed() { for (const fn of fns) fn(h); }
  function later(fn, ms) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); }
  function say(text, bad = false) {
    const o = h.outcome = {text, bad};
    later(() => { if (h.outcome === o) { h.outcome = null; changed(); } }, outcomeMs);
    changed();
  }
  async function refresh() {
    const id = chart === undefined ? outdoor(h)?.id : chart;
    const [needs, rules, hist] = await Promise.all([
      host.call('habitat.needs', {}).catch(() => null),
      admin ? host.call('habitat.rules', {}).catch(() => null) : null,
      id && h.byId.has(id) ? host.call('habitat.history', {query: {entity_id: id, since: new Date(clock() - 24 * 3600000).toISOString()}}).catch(() => null) : null,
    ]);
    if (needs) h.needs = list(needs, 'needs');
    if (rules) h.rules = list(rules, 'rules');
    if (hist) h.chart = hourly(h.byId.get(id), list(hist, 'states'));
    changed();
  }
  function apply({entity_id: id, new: s} = {}) {
    if (!id) return;
    const old = h.states.get(id);
    if (s) h.states.set(id, s); else h.states.delete(id);
    h.busy.delete(id); // its change came: the control is idle again
    const e = h.byId.get(id);
    if (e && old && s && old.state !== s.state && NOTED.has(e.domain) && s.state !== 'unavailable')
      h.changes = [{entity_id: id, state: s, at: Date.parse(s.last_changed) || clock()}, ...h.changes.filter(c => c.entity_id !== id)].slice(0, 6);
    changed();
  }
  async function run(c) {
    h.busy.add(c.entity_id);
    changed();
    let r = null, err = null;
    try { r = await host.call('habitat.act', {body: {action: c.action, target: {entity_id: [c.entity_id]}}}); } catch (e) { err = e?.message ?? String(e); }
    if (err || !r?.ok) {
      h.busy.delete(c.entity_id);
      say(`Couldn’t ${c.verb.toLowerCase()} ${c.name}: ${err ?? r?.error ?? 'failed'}`, true);
    } else {
      // idle again when its state changes, or after a while when Habitat records it only (shadow) or the device stays put
      later(() => { if (h.busy.delete(c.entity_id)) changed(); }, 10000);
      say(`${c.verb} ${c.name}${r.shadow ? ' (recorded in shadow)' : ''}`);
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
  if (h.needs.length) out.push({id: 'needs', label: 'Needs you', value: String(h.needs.length), tone: 'warn'});
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
  if (ids) return ids.map(id => h.byId.get(id)).filter(Boolean);
  const by = d => ofDomain(h, d);
  return [...by('scene'), ...by('cover'), ...by('lock'), ...by('light').sort((a, b) => (a.area ?? '~').localeCompare(b.area ?? '~') || a.name.localeCompare(b.name))];
}

/** Rooms by name, each its entities with a control or a reading (no cameras, scenes, people or the weather): [{area, name, entities}]. */
export function rooms(h, names = {}) {
  const by = new Map();
  for (const e of h.entities) {
    if (['camera', 'scene', 'weather', 'person'].includes(e.domain)) continue;
    (by.get(e.area ?? null) ?? by.set(e.area ?? null, []).get(e.area ?? null)).push(e);
  }
  return [...by].map(([area, entities]) => ({area, name: roomName(area, names), entities})).sort((a, b) => (a.area == null) - (b.area == null) || a.name.localeCompare(b.name));
}

/** The admin's entities: `q` in the name or id, `domain` one; unavailable first, then by id. */
export function entities(h, {q = '', domain = null} = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return h.entities.filter(e => (!domain || e.domain === domain) && words.every(w => e.name.toLowerCase().includes(w) || e.id.includes(w)))
    .sort((a, b) => (st(h, b.id) === 'unavailable') - (st(h, a.id) === 'unavailable') || a.id.localeCompare(b.id));
}
