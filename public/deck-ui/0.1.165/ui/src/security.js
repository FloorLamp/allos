// Read-only Security source controller. Sources are authorized HTTP adapters supplied by the host.
export const SECURITY_SOURCES = ['secrets', 'identity', 'tokens', 'external', 'public', 'findings'];
const FIELDS = ['id', 'what', 'where', 'owner', 'created', 'lastUsed', 'lastRotated', 'nextDue', 'state'];
export function createSecurity(sources = {}) {
  const listeners = new Set();
  let generation = 0;
  const blank = () => SECURITY_SOURCES.map(id => ({id, state: 'unavailable', generated: null, items: []}));
  const model = {sources: blank(), loading: false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { generation++; model.sources = blank(); listeners.clear(); },
    async refresh() {
      const round = ++generation;
      // Clear protected metadata while reauthorizing; never retain it after an access denial.
      model.sources = blank(); model.loading = true; changed();
      const results = await Promise.all(SECURITY_SOURCES.map(async id => {
        if (!sources[id]) return {id, state: 'unavailable', generated: null, items: []};
        try {
          const result = await sources[id]();
          if (!Array.isArray(result?.items) || (result.state != null && !['ok', 'stale'].includes(result.state))) throw new Error('invalid source');
          return {id, state: result.state === 'stale' ? 'stale' : 'ok', generated: typeof result.generated === 'string' ? result.generated : null,
            items: result.items.map(item => Object.fromEntries(FIELDS.map(k => [k, typeof item[k] === 'string' ? item[k] : null])))};
        } catch { return {id, state: 'unavailable', generated: null, items: []}; }
      }));
      if (generation !== round) return;
      model.sources = results; model.loading = false; changed();
    },
  };
  function changed() { for (const fn of listeners) fn(model); }
  return model;
}
