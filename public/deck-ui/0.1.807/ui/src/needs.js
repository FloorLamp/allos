import {mergeNeeds, needOrigin} from './needs-merge.js';
import {itemPath} from './flightplan-paths.js';
export {mergeNeeds, needOrigin} from './needs-merge.js';

const shared = new WeakMap();
const originKey = (need, backend) => { const origin = needOrigin(need, backend); return JSON.stringify([origin.backend, origin.id]); };
/** A polled backend need keeps its original identity; ordinary owner/work items are Flightplan needs of their own. */
export function itemNeed(item) {
  const ref = item.links?.find(link => link.type === 'need')?.ref;
  const [backend, ...parts] = ref?.split(':') ?? [];
  return {id: String(item.id), title: item.title, detail: item.notes ?? null, item,
    ...(backend && parts.length ? {from: {backend, id: parts.join(':')}} : {}),
    action: {kind: 'url', label: 'Review', url: itemPath(item)}};
}

/** One page's source. Every badge/card/list counts this same deduplicated union; ordinary todos retain their own list scopes. */
export function createNeeds(host, {backends = () => ['bridge', ...(host.backends ?? [])]} = {}) {
  const lists = new Map(), listeners = new Set(), patches = new Map();
  let pending = null, queried = null, generation = 0;
  let successful = new Set(), names = [];
  const selectedBackends = selected => [...new Set(['bridge', ...(typeof selected === 'function' ? selected() : selected)])];
  const state = {needs: [], count: 0, loading: true, refreshing: false, failures: [], flightplanItems: [],
    ensure({backends: selected = backends} = {}) {
      const key = JSON.stringify(selectedBackends(selected).sort());
      return !state.loading && queried === key ? Promise.resolve(state) : state.refresh({backends: selected});
    },
    /** A saved Flightplan item updates the canonical union immediately; live backend needs remain authoritative. */
    patchItem(item) {
      if (item?.id == null) return;
      patches.set(item.id, {item, generation: ++generation});
      const items = (lists.get('flightplan-items') ?? []).filter(need => need.item.id !== item.id);
      if (item.status === 'needs-you') items.push(itemNeed(item));
      lists.set('flightplan-items', items);
      recompute();
      for (const fn of listeners) fn(state);
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh({force = false, backends: selected = backends} = {}) {
      const requested = selectedBackends(selected), key = JSON.stringify([...requested].sort());
      if (pending) return force || queried !== key ? pending.then(() => state.refresh({backends: selected})) : pending;
      queried = key;
      names = requested;
      const readGeneration = generation;
      const sources = [...names.filter(backend => backend === 'bridge' && host.caps?.needs !== false).map(backend => [backend, `${backend}.needs`]), ...(names.includes('flightplan') ? [['flightplan-items', 'flightplan.needs-you']] : [])];
      state.refreshing = true;
      pending = (async () => {
        const failures = [], readSuccessful = new Set();
        await Promise.all(sources.map(async ([backend, op]) => {
          try {
            const result = await host.call(op, {});
            if (backend === 'bridge' && !Array.isArray(result?.needs)) throw new Error('bridge: no reviews snapshot');
            if (backend === 'flightplan-items' || Array.isArray(result?.needs)) readSuccessful.add(backend);
            if (backend === 'flightplan-items') {
              const items = new Map((result?.items ?? []).map(item => [item.id, item]));
              // A read already in flight at write completion may contain the previous item or omit a newly created need.
              for (const [id, patch] of patches) {
                const incoming = items.get(id);
                if (patch.generation > readGeneration || (incoming && incoming.revision < patch.item.revision)) {
                  if (patch.item.status === 'needs-you') items.set(id, patch.item); else items.delete(id);
                } else patches.delete(id);
              }
              lists.set(backend, [...items.values()].map(itemNeed));
            } else lists.set(backend, (result?.needs ?? []).map(need => need.action?.kind === 'link' ? {...need, action: {...need.action, kind: 'url'}} : need));
          } catch (error) {
            if (error?.code === 'unsupported') lists.delete(backend);
            else failures.push({backend: backend === 'flightplan-items' ? 'flightplan' : backend, op, error});
          }
        }));
        successful = readSuccessful;
        recompute();
        state.loading = false; state.refreshing = false; state.failures = failures;
        for (const fn of listeners) fn(state);
        return state;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
  function recompute() {
    const items = names.includes('flightplan') ? lists.get('flightplan-items') ?? [] : [];
    state.flightplanItems = items.map(need => need.item);
    const byOrigin = new Map(items.map(need => [originKey(need, 'flightplan'), need.item]));
    // Bridge is authoritative for every origin, including old Flightplan poller copies.
    const current = need => !need.from || !successful.has('bridge') ||
      (lists.get('bridge') ?? []).some(direct => originKey(direct, 'bridge') === originKey(need, 'flightplan'));
    state.needs = mergeNeeds([
      ['flightplan', items.filter(current)],
      ...names.map(backend => [backend, (lists.get(backend) ?? []).filter(current)]),
    ]).map(need => ({...need, ...(byOrigin.has(originKey(need, need.backend)) ? {item: byOrigin.get(originKey(need, need.backend))} : {})}));
    state.count = state.needs.length;
  }
  return state;
}

/** Reuse across mounts using one host; consumer pages with separate host objects pass the source explicitly as needsSource. */
export function needsFor(host) {
  if (!shared.has(host)) {
    const source = createNeeds(host);
    shared.set(host, source);
    host.on?.('needs', () => { source.refresh({force: true}); });
  }
  return shared.get(host);
}
