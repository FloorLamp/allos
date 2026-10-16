import {describeFailure} from './failure.js';
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

/** On open/refresh, me must authorize before any personal data is requested. No persisted health data. */
export function createHealth(host) {
  const listeners = new Set();
  let generation = 0, stopped = false;
  const changed = () => { if (!stopped) for (const fn of listeners) fn(h); };
  const clear = () => Object.assign(h, {owner: false, me: null, profiles: [], profile: null, board: null, readings: [], labs: [], results: [], answer: null});
  const query = extra => ({...(h.profile != null ? {profile: h.profile} : {}), ...extra});
  const h = {
    owner: false, me: null, profiles: [], profile: null, board: null, readings: [], labs: [], results: [], answer: null,
    loading: true, error: null, status: '', busy: false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { off(); stopped = true; generation++; clear(); listeners.clear(); },
    start() { return h.refresh(); },
    async refresh(profile = h.profile) {
      const n = ++generation;
      clear(); h.loading = true; h.error = null; changed();
      const me = await healthIdentity(host, {onFailure: e => { if (n === generation && !stopped) h.error = describeFailure('allos', e); }});
      if (n !== generation || stopped) return;
      if (!me) { h.loading = false; changed(); return; }
      h.me = me; h.owner = true;
      try {
        const available = await host.call('allos.profiles', {});
        if (n !== generation || stopped) return;
        h.profiles = available.profiles ?? [];
        h.profile = h.profiles.some(p => p.id === profile) ? profile : available.profile;
      } catch (e) { if (n !== generation || stopped) return; clear(); h.error = describeFailure('allos', e); h.loading = false; changed(); return; }
      try {
        const [board, readings, labs] = await Promise.all(['board', 'readings', 'labs'].map(op => host.call(`allos.${op}`, {query: query({})})));
        if (n !== generation || stopped) return;
        Object.assign(h, {board, readings: readings.readings ?? [], labs: labs.labs ?? []});
      } catch (e) { if (n !== generation || stopped) return; clear(); h.error = describeFailure('allos', e); }
      h.loading = false; changed();
    },
    async search(q, ask = false) {
      const n = ++generation;
      h.results = []; h.answer = null; h.error = null; changed();
      const me = await healthIdentity(host, {onFailure: e => { if (n === generation && !stopped) h.error = describeFailure('allos', e); }});
      if (n !== generation || stopped) return;
      if (!me) { clear(); changed(); return; }
      try {
        const r = await host.call(ask ? 'allos.ask' : 'allos.find', {query: query({q})});
        if (n !== generation || stopped) return;
        if (ask) h.answer = r; else h.results = r.results ?? [];
      } catch (e) { if (n !== generation || stopped) return; clear(); h.error = describeFailure('allos', e); }
      changed();
    },
    async write(op, body, extra = {}) {
      if (!h.owner || h.busy || h.profiles?.find(p => p.id === h.profile)?.access !== 'write') return;
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
