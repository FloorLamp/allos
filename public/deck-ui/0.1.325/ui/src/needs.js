// Shared Needs snapshot for the header, home card and Attention list. Read only
// needs endpoints: unreadable documents in attention/count are not owner needs.
export function mergeNeeds(lists) {
  const merged = new Map();
  for (const [backend, needs] of lists) for (const need of needs) {
    const origin = need.from ?? {backend, id: need.id};
    const key = JSON.stringify([origin.backend, origin.id]);
    if (!merged.has(key) || !need.from) merged.set(key, {...need, backend});
  }
  return [...merged.values()];
}

/** Share one instance across a page's badge, card and list. Habitat's registry
 * needs op maps to /api/house/needs; bridge's maps to /api/needs. Failed reads
 * retain the last successful list and report errors rather than clearing needs. */
export function createNeeds(host, {backends = ['bridge', 'habitat']} = {}) {
  const lists = new Map(), listeners = new Set();
  const state = {needs: [], count: 0, loading: true, failures: [],
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {
      const failures = [];
      await Promise.all([...new Set(backends)].map(async backend => {
        try { lists.set(backend, (await host.call(`${backend}.needs`, {}))?.needs ?? []); }
        catch (error) { failures.push({backend, error}); }
      }));
      state.needs = mergeNeeds([...new Set(backends)].map(backend => [backend, lists.get(backend) ?? []]));
      state.count = state.needs.length;
      state.loading = false;
      state.failures = failures;
      for (const fn of listeners) fn(state);
      return state;
    },
  };
  return state;
}
