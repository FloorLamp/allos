import {describeFailure} from './failure.js';
// Identity and renewal facts are bridge's Papers projection (bridge:find).
export const papersQuery = q => /^(papers|identity papers)$/i.test(String(q).trim());
export const paperState = p => ({current: 'Current', expired: 'Expired', unknown: 'Unknown'}[p.state] ?? 'Unknown');
export const renewalState = p => p.renewal ? 'Application pending' : p.state === 'expired' ? 'Renewal needed' : p.state === 'current' ? 'No pending application indexed' : 'Renewal need unknown';
export function paperRow(p) {
  return {id: p.id, title: `${p.person.name} · ${p.kind}`, glyph: 'document',
    sub: [p.scope, `Expiry: ${p.expiry ?? 'Unknown'}`, paperState(p), renewalState(p)].filter(Boolean).join(' · ')};
}
export function createPapers(host) {
  let stopped = false, generation = 0, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    papers: [], loading: false, error: null,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.papers', {}, {signal});
        const papers = (answer?.results ?? []).filter(r => r.paper).map(r => ({...r.paper, state: r.state}));
        if (!stopped && current === generation) model.papers = papers;
      } catch (e) {
        if (!stopped && current === generation) { model.papers = []; model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); generation++; subscribers.clear(); },
  };
  return model;
}
