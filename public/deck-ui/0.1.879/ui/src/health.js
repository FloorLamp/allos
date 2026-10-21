import {describeFailure} from './failure.js';
import {dateText, fieldLabel, joinText} from './format.js';
import {delta} from './quantity.js';
// Health uses allos's device API (contract/health.md *Health*), never bridge.
const identityListeners = new WeakMap();
export function watchHealthIdentity(host, fn) {
  if (!identityListeners.has(host)) identityListeners.set(host, new Set());
  const listeners = identityListeners.get(host);
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export async function healthIdentity(host, {onFailure} = {}) {
  let me = null, failure = null;
  if (host.backends?.includes('allos')) {
    try { const r = await host.call('allos.me', {}); if (r?.owner === true) me = r; } catch (e) { failure = e; }
  }
  if (failure) onFailure?.(failure);
  for (const fn of identityListeners.get(host) ?? []) fn(me);
  return me;
}

export const healthQuery = q => /^health:\s*/i.test(q) ? q.replace(/^health:\s*/i, '') : null;
export const healthId = key => `allos:${key}`;
export const healthKey = id => typeof id === 'string' && id.startsWith('allos:') ? id.slice(6) : null;
export const healthResults = results => results.map(r => ({kind: 'document', document: {
  id: healthId(r.key), title: r.title, summary: r.subtitle, date: r.date, type: r.kind, source: 'allos', file: false,
  health: {key: r.key},
}}));

/** `Thu, Oct 15` (format.js; the year when it is not this one). */
export const dayText = value => dateText(value, {weekday: true, now: new Date()});
const READING_NAMES = {resting_hr: 'Resting heart rate', spo2: 'Oxygen saturation'};
export const readingName = kind => READING_NAMES[kind] ?? fieldLabel(kind);

// Newest first per key, the one before it the trend's comparison. allos sends no history beyond its list, so a single entry has no trend.
const latest = (list, keyOf) => {
  const by = new Map();
  for (const item of [...list].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))) {
    const key = keyOf(item);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(item);
  }
  return [...by.entries()];
};
// the comparison's day, short: a tile is narrow on a phone
const since = from => from?.date ? `since ${dateText(from.date, {now: new Date()})}` : null;
// a key-like part (`stale`, `non-optimal-low`) reads as words
const sub = (...parts) => joinText(parts.map(p => p && /^[a-z]+(?:[-_][a-z]+)*$/.test(p) ? fieldLabel(p) : p));
// allos sends a lab's value as text (`'5.4'`); text that is no number shows as given
const labNumber = value => typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

/** Readings as stat tiles: the newest per kind, its change since the one before. Blood pressure reads as one figure, both parts changed.
 *  A change is neither good nor bad here: Deck makes no medical judgement (contract/health.md). */
export function readingTiles(readings = []) {
  return latest(readings, r => r.kind).map(([kind, [now, before]]) => {
    if (kind === 'blood_pressure') {
      const d = before && [now.systolic - before.systolic, now.diastolic - before.diastolic];
      const sign = n => n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
      return {key: kind, label: readingName(kind), value: `${now.systolic}/${now.diastolic} ${now.unit ?? 'mmHg'}`, sub: sub(dayText(now.date), now.freshness),
        delta: d ? {text: `${sign(d[0])}/${sign(d[1])}`, tone: 'neutral', dir: d[0] > 0 ? 'up' : d[0] < 0 ? 'down' : 'flat', label: since(before)} : null};
    }
    const q = {value: now.value, unit: now.unit};
    return {key: kind, label: readingName(kind), quantity: q, sub: sub(dayText(now.date), now.freshness),
      delta: before ? delta(q, {value: before.value}, {label: since(before), pct: false}) : null};
  });
}

/** Labs as stat tiles: the newest result per test, allos's flag beside its day (a flag other than normal is the tile's tone). */
export function labTiles(labs = []) {
  return latest(labs, l => l.name).map(([name, [now, before]]) => {
    const flagged = now.flag && now.flag !== 'normal';
    const value = labNumber(now.value), common = {key: name, label: name, sub: sub(now.flag, dayText(now.date))};
    if (value == null) return {...common, value: now.value == null || now.value === '' ? null : joinText([now.value, now.unit], ' '), delta: null};
    const q = {value, unit: now.unit, tone: flagged ? 'bad' : 'neutral'};
    return {...common, quantity: q,
      delta: before && before.unit === now.unit ? delta(q, {value: labNumber(before.value)}, {label: since(before), pct: false}) : null};
  });
}

/** On open/refresh, me must authorize before any personal data is requested. No persisted health data. */
export function createHealth(host) {
  const listeners = new Set();
  let generation = 0, stopped = false;
  const changed = () => { if (!stopped) for (const fn of listeners) fn(h); };
  const clear = () => Object.assign(h, {searching: false, owner: false, me: null, profiles: [], profile: null, board: null, readings: [], labs: [], results: [], answer: null});
  const query = extra => ({...(h.profile != null ? {profile: h.profile} : {}), ...extra});
  const h = {
    owner: false, me: null, profiles: [], profile: null, board: null, readings: [], labs: [], results: [], answer: null,
    loading: true, error: null, status: '', busy: false, searching: false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { off(); stopped = true; generation++; clear(); listeners.clear(); },
    start() { return h.refresh(); },
    async refresh(profile = h.profile) {
      const n = ++generation;
      h.loading = true; h.error = null; h.searching = false; changed();
      const me = await healthIdentity(host, {onFailure: e => { if (n === generation && !stopped) h.error = describeFailure('allos', e); }});
      if (n !== generation || stopped) return;
      if (!me) { h.loading = false; changed(); return; }
      h.me = me; h.owner = true;
      let profiles, selected;
      try {
        const available = await host.call('allos.profiles', {});
        if (n !== generation || stopped) return;
        profiles = available.profiles ?? [];
        selected = profiles.some(p => p.id === profile) ? profile : available.profile;
      } catch (e) { if (n !== generation || stopped) return; clear(); h.error = describeFailure('allos', e); h.loading = false; changed(); return; }
      try {
        const [board, readings, labs] = await Promise.all(['board', 'readings', 'labs'].map(op => host.call(`allos.${op}`, {query: selected != null ? {profile: selected} : {}})));
        if (n !== generation || stopped) return;
        Object.assign(h, {profiles, profile: selected, results: [], answer: null, board, readings: readings.readings ?? [], labs: labs.labs ?? []});
      } catch (e) { if (n !== generation || stopped) return; clear(); h.error = describeFailure('allos', e); }
      h.loading = false; changed();
    },
    async search(q, ask = false) {
      if (h.loading) return;
      const n = ++generation;
      h.results = []; h.answer = null; h.error = null; h.searching = true; changed();
      const me = await healthIdentity(host, {onFailure: e => { if (n === generation && !stopped) h.error = describeFailure('allos', e); }});
      if (n !== generation || stopped) return;
      if (!me) { clear(); changed(); return; }
      try {
        const r = await host.call(ask ? 'allos.ask' : 'allos.find', {query: query({q})});
        if (n !== generation || stopped) return;
        if (ask) h.answer = r; else h.results = r.results ?? [];
      } catch (e) { if (n !== generation || stopped) return; clear(); h.error = describeFailure('allos', e); }
      h.searching = false; changed();
    },
    async write(op, body, extra = {}) {
      if (!h.owner || h.loading || h.busy || h.profiles?.find(p => p.id === h.profile)?.access !== 'write') return;
      h.busy = true; h.status = ''; h.statusBad = false; changed();
      try {
        // Call before awaiting: the browser's active gesture must reach the host's POST gate.
        const r = await host.call(`allos.${op}`, {query: query(extra), body});
        await h.refresh();
        h.status = r.statedTimeRefused ? 'Saved; the stated time was refused' : 'Saved';
      } catch (e) { h.status = describeFailure('allos', e).message; h.statusBad = true; }
      h.busy = false; changed();
    },
    dose(id, action) { return h.board ? h.write('dose', {action, day: h.board.day}, {dose: String(id)}) : Promise.resolve(); },
    logReading(body) { return h.write('log-reading', body); },
  };
  const off = watchHealthIdentity(host, me => {
    if (me) return;
    generation++; clear(); h.loading = false; changed();
  });
  return h;
}
