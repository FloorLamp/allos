import {compareNames} from './names.js';
import {dateText, fieldLabel, placeLabel} from './format.js';
import {readBridge, resourcePath} from './host/host.js';
import {describeFailure} from './failure.js';
import {maskedIdentifier} from './identifiers.js';
import {paperProjection} from './collection-projections.js';
import {RANK, needsAction, withStanding} from './paper-standing.js';
// Identity and renewal facts are bridge's Papers projection (bridge:find).
export const paperState = p => p.standing === 'replaced' ? 'Replaced' : ({current: 'Current', expired: 'Expired', unknown: 'Unknown'}[p.state] ?? 'Unknown');
export const renewalState = p => p.renewal ? 'Application pending' : p.standing === 'replaced' ? 'Replaced by a newer paper' : p.state === 'expired' ? 'Renewal needed'
  : p.state === 'current' ? 'No pending application indexed' : 'Renewal need unknown';
/** Only what asks for something: a pending application or an expired paper's renewal; nothing when there is nothing to do (a
 *  replaced paper asks for nothing). */
const renewalNote = p => p.renewal ? 'Renewal application pending' : p.state === 'expired' && p.standing !== 'replaced' ? 'Renewal needed' : null;
const byKind = (a, b) => a.kind.localeCompare(b.kind) || (a.expiry || '9999-12-31').localeCompare(b.expiry || '9999-12-31');
/** Each holder's papers together (grouped before paging, so they stay together across pages), names in order; within a holder what
 *  needs action (expired and not replaced, or expiring within 90 days) soonest first, then current and expiry unknown by kind, the
 *  replaced last. Papers come back with `standing` and `replacedBy` (paper-standing.js); `today` an ISO day. */
export function sortedPapers(papers, opts) {
  return withStanding(papers, opts).sort((a, b) => compareNames(a.person.name, b.person.name)
    || String(a.person.id).localeCompare(String(b.person.id))
    || RANK[a.standing] - RANK[b.standing]
    || (needsAction(a) ? (a.expiry || '').localeCompare(b.expiry || '') : byKind(a, b))
    || a.id.localeCompare(b.id));
}
const BADGE = {expired: {text: 'Expired', tone: 'bad'}, expiring: {text: 'Expiring', tone: 'warn'}, current: {text: 'Current'}, replaced: {text: 'Replaced'}};
// the holder's portrait (bridge's `person.photo`: their People page's, whose id is not the paper's holder id), a person photo path only
const holderPhoto = person => /^\/v1\/people\/[^/?]+\/photo$/.test(person?.photo ?? '') && resourcePath(person.photo) ? person.photo : null;
export function paperRow(p) {
  const kind = fieldLabel(p.kind), scope = p.scope ? placeLabel(p.scope) : '';
  return {id: p.id, title: kind, glyph: 'id',
    section: {key: p.person.id, label: p.person.name, link: {kind: 'person', id: p.person.id}, avatar: {path: holderPhoto(p.person), name: p.person.name}},
    badge: BADGE[p.standing ?? p.state] ?? null,
    sub: [...new Set([scope && scope.toLowerCase() !== kind.toLowerCase() ? scope : null,
      p.number && p.number !== p.scope ? `Number ${maskedIdentifier(p.number)}` : null,
      p.expiry ? `${p.state === 'expired' ? 'Expired' : 'Expires'} ${dateText(p.expiry)}` : 'Expiry not indexed', renewalNote(p)].filter(Boolean))].join(' · ')};
}
/** A paper's facts for its drawer: only what is known (an unknown scope or state is left out, as a policy's are). */
export function paperFacts(p) {
  return [
    p.scope ? {label: 'Scope', value: placeLabel(p.scope)} : null,
    p.number ? {label: 'Number', value: maskedIdentifier(p.number)} : null,
    {label: 'Expiry', value: p.expiry ? dateText(p.expiry) : 'Not indexed'},
    p.standing === 'replaced' || p.state && p.state !== 'unknown' ? {label: 'State', value: paperState(p)} : null,
    renewalNote(p) ? {label: 'Renewal', value: p.renewal ? 'Application pending' : 'Needed'} : null,
  ].filter(Boolean);
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
        if (!stopped && current === generation) { model.error = describeFailure('bridge', e); if (model.error.state !== 'warming') model.papers = []; }
      }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); generation++; subscribers.clear(); },
  };
  return model;
}
