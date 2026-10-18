import {readBridge} from './host/host.js';
import {describeFailure} from './failure.js';
import {maskedIdentifier} from './identifiers.js';
import {paperProjection} from './collection-projections.js';
// Identity and renewal facts are bridge's Papers projection (bridge:find).
export const papersQuery = q => /^(papers|identity papers)$/i.test(String(q).trim());
export const paperState = p => ({current: 'Current', expired: 'Expired', unknown: 'Unknown'}[p.state] ?? 'Unknown');
export const renewalState = p => p.renewal ? 'Application pending' : p.state === 'expired' ? 'Renewal needed' : p.state === 'current' ? 'No pending application indexed' : 'Renewal need unknown';
export function paperRow(p) {
  return {id: p.id, title: `${p.person.name} · ${p.kind}`, glyph: 'document',
    sub: [p.scope, p.number ? `Number: ${maskedIdentifier(p.number)}` : null, `Expiry: ${p.expiry ?? 'Unknown'}`, paperState(p), renewalState(p)].filter(Boolean).join(' · ')};
}
const collectionRows = answer => (answer?.results ?? []).filter(r => r.paper).map(r => paperProjection(r.paper, r.state));
export function createPapers(host) {
  let stopped = false, generation = 0, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    papers: [], loading: false, warming: false, error: null,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.warming = false; model.loading = true; model.error = null; changed();
      try {
        const answer = await readBridge(host, 'bridge.papers', {}, {signal,
          snapshot: answer => { if (model.papers.length) return; model.papers = collectionRows(answer); changed(); },
          warming: () => { if (!signal.aborted) { model.warming = true; changed(); } },
        });
        const papers = collectionRows(answer);
        if (!stopped && current === generation) model.papers = papers;
      } catch (e) {
        if (!stopped && current === generation) { model.papers = []; model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); generation++; subscribers.clear(); },
  };
  return model;
}
