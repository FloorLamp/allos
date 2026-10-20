import {dateText, fieldLabel, placeLabel} from './format.js';
import {readBridge} from './host/host.js';
import {describeFailure} from './failure.js';
import {maskedIdentifier} from './identifiers.js';
import {paperProjection} from './collection-projections.js';
// Identity and renewal facts are bridge's Papers projection (bridge:find).
export const paperState = p => ({current: 'Current', expired: 'Expired', unknown: 'Unknown'}[p.state] ?? 'Unknown');
export const renewalState = p => p.renewal ? 'Application pending' : p.state === 'expired' ? 'Renewal needed' : p.state === 'current' ? 'No pending application indexed' : 'Renewal need unknown';
/** Only what asks for something: a pending application or an expired paper's renewal; nothing when there is nothing to do. */
const renewalNote = p => p.renewal ? 'Renewal application pending' : p.state === 'expired' ? 'Renewal needed' : null;
// Group before paging so each holder's papers stay together across pages.
export function sortedPapers(papers) {
  return [...papers].sort((a, b) => a.person.name.localeCompare(b.person.name)
    || String(a.person.id).localeCompare(String(b.person.id))
    || (a.expiry || '9999-12-31').localeCompare(b.expiry || '9999-12-31')
    || a.id.localeCompare(b.id));
}
export function paperRow(p) {
  const kind = fieldLabel(p.kind), scope = p.scope ? placeLabel(p.scope) : '';
  return {id: p.id, title: kind, glyph: 'id',
    section: {key: p.person.id, label: p.person.name},
    badge: p.state === 'expired' ? {text: 'Expired', tone: 'bad'} : p.state === 'current' ? {text: 'Current'} : null,
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
    p.state && p.state !== 'unknown' ? {label: 'State', value: paperState(p)} : null,
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
