import {readBridge} from './host/host.js';
import {describeFailure} from './failure.js';
import {maskedIdentifier} from './identifiers.js';
import {dateText} from './quantity.js';
import {policyProjection} from './collection-projections.js';
// Policy identity and links come only from bridge's documented Insurance projection.
export const insuranceQuery = q => /^(insurance|polic(?:y|ies))$/i.test(String(q).trim());
export function policyStatus(policy, today = new Date().toISOString().slice(0, 10)) {
  if (policy.state) return {current: 'In term', expired: 'Expired', future: 'Upcoming', unknown: 'Status unknown'}[policy.state] ?? 'Status unknown';
  if (policy.term?.start && policy.term.start > today) return 'Upcoming';
  if (policy.term?.end) return policy.term.end < today ? 'Term ended' : 'In term';
  return 'Status unknown';
}
export const coveredBy = p => [p.insured?.name, p.home, ...(p.vehicles ?? []).map(v => v.name)].filter(Boolean).join(' · ') || 'Covered party not indexed';
export const policyDate = value => value ? dateText(value, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}) : 'Unknown';
const policyGroup = p => ({current: 'Active', future: 'Upcoming', expired: 'Expired', unknown: 'Status unknown'}[p.state]
  ?? ({'In term': 'Active', 'Term ended': 'Expired', Upcoming: 'Upcoming'}[policyStatus(p)] ?? 'Status unknown'));
export function insuranceRow(p) {
  const expired = policyGroup(p) === 'Expired';
  const subtitle = p.subtitle ?? [p.kind, p.number ? `Policy ${maskedIdentifier(p.number)}` : null, p.insured?.name, p.home,
    ...(p.vehicles ?? []).map(v => v.name), (p.renewal || p.term?.end) ? `${expired ? 'expired' : 'renews'} ${expired ? p.term?.end || p.renewal : p.renewal || p.term?.end}` : null].filter(Boolean).join(' · ');
  return {id: p.id, title: p.name, glyph: 'contract',
    badge: {text: policyStatus(p)},
    section: {key: policyGroup(p), label: policyGroup(p)},
    sub: subtitle.replace(/\b\d{4}-\d{2}-\d{2}\b/g, policyDate)};
}
const collectionRows = answer => (answer?.results ?? []).filter(r => r.insurance)
  .map(r => ({...policyProjection(r.insurance), ...(r.subtitle != null ? {subtitle: r.subtitle} : {})}))
  .sort((a, b) => ['Active', 'Upcoming', 'Status unknown', 'Expired'].indexOf(policyGroup(a)) - ['Active', 'Upcoming', 'Status unknown', 'Expired'].indexOf(policyGroup(b)));
export function createInsurance(host) {
  let stopped = false, generation = 0, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    policies: [], loading: false, warming: false, error: null,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.warming = false; model.loading = true; model.error = null; changed();
      try {
        const answer = await readBridge(host, 'bridge.insurance', {}, {signal,
          snapshot: answer => { if (model.policies.length) return; model.policies = collectionRows(answer); changed(); },
          warming: () => { if (!signal.aborted) { model.warming = true; changed(); } },
        });
        const policies = collectionRows(answer);
        if (!stopped && current === generation) model.policies = policies;
      } catch (e) {
        if (!stopped && current === generation) { model.error = describeFailure('bridge', e); if (model.error.state !== 'warming') model.policies = []; }
      }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); generation++; subscribers.clear(); },
  };
  return model;
}

/** Keep policy documents in the collection drawer, with other Find matches below it. */
export function insuranceMatches(rows, policies) {
  const documents = new Set((policies ?? []).flatMap(p => p.documents ?? []).map(d => String(d.id)));
  return rows.filter(r => !r.result || policies != null &&
    !policies.some(p => p.id === r.result.insurance?.id) && !documents.has(String(r.result.document?.id)));
}
