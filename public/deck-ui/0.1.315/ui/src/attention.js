/** Attention snapshots and mutations. Count is locked documents plus recent gaps, never unsupported or ignored files. */
export function createAttention(host, {onCount = () => {}} = {}) {
  const listeners = new Set();
  let stopped = false, request, count, mutation;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    tab: 'locked', items: [], gaps: [], coverage: [], ignored: [], loading: false, busy: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setTab(tab) { if (['locked', 'unsupported', 'gaps', 'coverage', 'ignored'].includes(tab)) { model.tab = tab; notify(); } },
    async refresh() {
      if (stopped) return;
      request?.abort();
      const current = request = new AbortController();
      model.loading = true; model.error = null; notify();
      try {
        const [a, g, i] = await Promise.all(['bridge.attention', 'bridge.gaps', 'bridge.ignored'].map(op => host.call(op, {}, {signal: current.signal})));
        if (current.signal.aborted || stopped) return;
        model.items = a.items; model.gaps = g.gaps; model.coverage = g.coverage; model.ignored = i.results;
        const next = a.items.filter(d => d.kind === 'locked').length + g.gaps.length;
        if (next !== count) { count = next; onCount(count); }
      } catch (error) { if (!current.signal.aborted && !stopped) model.error = error; }
      finally { if (!current.signal.aborted && !stopped) { model.loading = false; notify(); } }
    },
    async mutate(action, ids, password) {
      if (stopped || model.busy || !ids.length) return;
      const op = {retry: 'bridge.attentionRetry', dismiss: 'bridge.attentionDismiss', restore: 'bridge.restore', gap: 'bridge.gapDismiss'}[action];
      if (!op) throw new Error('Unknown Attention action');
      mutation = new AbortController();
      model.busy = true; model.error = null; notify();
      try {
        await host.call(op, {ids, ...(action === 'retry' && password ? {password} : {})}, {signal: mutation.signal});
        if (!stopped) await model.refresh();
      } catch (error) { if (!stopped) model.error = error; }
      finally { if (!stopped) { model.busy = false; notify(); } }
    },
    stop() { if (stopped) return; stopped = true; request?.abort(); mutation?.abort(); listeners.clear(); onCount(null); },
  };
  return model;
}
