import {healthIdentity, watchHealthIdentity} from './health.js';
import {describeFailure} from './failure.js';

export const healthWorkflows = {imports: 'Import review', documents: 'Document picker', medications: 'Medications', trash: 'Trash'};

// Snapshots and edits live only in this mount. Revisions belong to the backend, never the shell.
export function createHealthWorkflow(host) {
  const listeners = new Set();
  let generation = 0, stopped = false;
  const emit = () => { if (!stopped) for (const fn of listeners) fn(); };
  const w = {
    kind: null, profile: null, q: '', snapshot: null, loading: false, busy: false, error: null, status: '',
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    clear() { generation++; w.snapshot = null; w.error = null; w.status = ''; w.loading = false; emit(); },
    stop() { stopped = true; off(); w.clear(); listeners.clear(); },
    async load(kind, profile, q = '', cursor = '') {
      if (!Object.hasOwn(healthWorkflows, kind)) return;
      const n = ++generation;
      Object.assign(w, {kind, profile, q, snapshot: null, loading: true, error: null, status: ''}); emit();
      try {
        const me = await healthIdentity(host);
        if (!me || n !== generation || stopped) return;
        const snapshot = await host.call(`allos.health.${kind}`, {query: {profile, q, cursor}});
        if (n !== generation || stopped) return;
        w.snapshot = snapshot;
      } catch (e) { if (n === generation && !stopped) w.error = describeFailure('allos', e); }
      finally { if (n === generation && !stopped) { w.loading = false; emit(); } }
    },
    async apply(item, action, values) {
      if (w.loading || w.busy || !w.snapshot || !item.actions?.some(a => a.id === action)) return;
      const n = generation, kind = w.kind, profile = w.profile;
      w.busy = true; w.error = null; w.status = ''; emit();
      try {
        // Keep this call in the initiating input event: the host enforces its gesture gate.
        await host.call(`allos.health.${kind}.apply`, {query: {profile}, body: {id: item.id, revision: item.revision, action, values}});
        if (n !== generation || stopped) return;
        await w.load(kind, profile, w.q);
        if (!stopped && generation === n + 1 && w.kind === kind && w.profile === profile && !w.error) { w.status = 'Saved'; emit(); }
      } catch (e) {
        if (n === generation && !stopped) { w.snapshot = null; w.error = describeFailure('allos', e); emit(); }
      } finally { w.busy = false; emit(); }
    },
  };
  const off = watchHealthIdentity(host, me => { if (!me) w.clear(); });
  return w;
}
