import {describeFailure} from './failure.js';
// Policy identity and links come only from bridge's documented Insurance projection.
export const insuranceQuery = q => /^(insurance|polic(?:y|ies))$/i.test(String(q).trim());
export function policyStatus(policy, today = new Date().toISOString().slice(0, 10)) {
  if (policy.term?.start && policy.term.start > today) return 'Upcoming';
  if (policy.term?.end) return policy.term.end < today ? 'Term ended' : 'In term';
  return 'Status unknown';
}
export const coveredBy = p => [p.insured?.name, p.home, ...(p.vehicles ?? []).map(v => v.name)].filter(Boolean).join(' · ') || 'Covered party not indexed';
export function insuranceRow(p) {
  return {id: p.id, title: p.name, glyph: 'document',
    sub: [p.kind, p.insured?.name, p.home, ...(p.vehicles ?? []).map(v => v.name),
      (p.renewal || p.term?.end) ? `renews ${p.renewal || p.term.end}` : null].filter(Boolean).join(' · ')};
}
export function createInsurance(host) {
  let stopped = false, generation = 0, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    policies: [], loading: false, error: null,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.insurance', {}, {signal});
        const policies = (answer?.results ?? []).filter(r => r.insurance).map(r => r.insurance);
        if (!stopped && current === generation) model.policies = policies;
      } catch (e) {
        if (!stopped && current === generation) { model.policies = []; model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); generation++; subscribers.clear(); },
  };
  return model;
}
