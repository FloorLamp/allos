import {HostError, readBridge} from './host/host.js';
import {textsItems} from './controller.js';

/** Read-only conversation list. Refresh replaces the snapshot; More appends a cursor page. */
export function createTexts(host) {
  const listeners = new Set();
  let request, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    items: [], next: null, loading: false, warming: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh(more = false) {
      if (stopped || more && (!model.next || model.loading)) return;
      request?.abort();
      const current = request = new AbortController();
      model.warming = false; model.loading = true; model.error = null; notify();
      try {
        if (!host.caps.texts) throw new HostError('unsupported');
        const answer = await readBridge(host, 'bridge.texts', {limit: 50, ...(more ? {cursor: model.next} : {})}, {signal: current.signal,
          snapshot: answer => { if (!more && !model.items.length) { model.items = textsItems(answer).map(row => ({...row, id: row.document.id})); notify(); } },
          warming: () => { if (!current.signal.aborted && !stopped) { model.warming = true; notify(); } },
        });
        if (current.signal.aborted || stopped) return;
        const rows = textsItems(answer).map(row => ({...row, id: row.document.id}));
        model.items = [...new Map([...(more ? model.items : []), ...rows].map(row => [row.id, row])).values()];
        model.next = answer?.next ?? null;
      } catch (error) { if (!current.signal.aborted && !stopped) model.error = error; }
      finally { if (!current.signal.aborted && !stopped) { model.warming = false; model.loading = false; notify(); } }
    },
    stop() { stopped = true; request?.abort(); listeners.clear(); },
  };
  return model;
}
