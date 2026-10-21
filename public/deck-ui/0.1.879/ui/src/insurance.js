import {readBridge} from './host/host.js';
import {describeFailure} from './failure.js';
import {maskedIdentifier} from './identifiers.js';
import {dateText, fieldLabel, isoDay} from './format.js';
import {policyProjection} from './collection-projections.js';
// Policy identity and links come only from bridge's documented Insurance projection.
export function policyStatus(policy, today = isoDay(new Date())) {
  if (policy.state) return {current: 'In term', expired: 'Expired', future: 'Upcoming', unknown: 'Status unknown'}[policy.state] ?? 'Status unknown';
  if (policy.term?.start && policy.term.start > today) return 'Upcoming';
  if (policy.term?.end) return policy.term.end < today ? 'Term ended' : 'In term';
  return 'Status unknown';
}
export const coveredBy = p => [p.insured?.name, p.home, ...(p.vehicles ?? []).map(v => v.name)].filter(Boolean).join(' · ') || 'Covered party not indexed';
const policyGroup = p => ({current: 'Active', future: 'Upcoming', expired: 'Expired', unknown: 'Status unknown'}[p.state]
  ?? ({'In term': 'Active', 'Term ended': 'Expired', Upcoming: 'Upcoming'}[policyStatus(p)] ?? 'Status unknown'));
const soon = (day, today = isoDay(new Date())) => !!day && day >= today && day <= isoDay(new Date(Date.parse(`${today}T12:00:00Z`) + 30 * 864e5));
export function insuranceRow(p) {
  const group = policyGroup(p), expired = group === 'Expired';
  const subtitle = p.subtitle ?? [p.kind ? fieldLabel(p.kind) : null, p.number ? `Policy ${maskedIdentifier(p.number)}` : null, p.insured?.name, p.home,
    ...(p.vehicles ?? []).map(v => v.name), (p.renewal || p.term?.end) ? `${expired ? 'Ended' : 'Renews'} ${expired ? p.term?.end || p.renewal : p.renewal || p.term?.end}` : null].filter(Boolean).join(' · ');
  return {id: p.id, title: p.name, glyph: 'contract',
    // the section says the group; a badge only for what it does not: a renewal inside the next 30 days
    badge: group === 'Active' && soon(p.renewal ?? p.term?.end) ? {text: 'Renews soon', tone: 'warn'} : null,
    section: {key: group, label: group},
    sub: subtitle.replace(/^\p{Ll}/u, c => c.toUpperCase()).replace(/\b\d{4}-\d{2}-\d{2}\b/g, d => dateText(d))};
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
