import {describeFailure} from './failure.js';
export const thingsQuery = q => /^things$/i.test(String(q).trim());
export const thingRow = t => ({id: t.id, title: t.name, glyph: 'document', sub: [t.kind ?? t.type, ...(t.person?.name ? [t.person.name] : []), t.store ?? 'Store unknown', t.purchaseDate ?? 'Purchase date unknown', t.status ?? 'Status unknown'].join(' · ')});
export function createThings(host) {
  let stopped = false, generation = 0, request, detailRequest, detailGeneration = 0;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    things: [], loading: false, error: null, id: null, thing: null, detailLoading: false, detailError: null,
    close() { detailRequest?.abort(); detailGeneration++; model.id = null; model.thing = null; model.detailLoading = false; model.detailError = null; changed(); },
    async open(id) {
      if (stopped) return;
      model.close(); model.id = id; model.detailLoading = true;
      const current = ++detailGeneration; detailRequest = new AbortController(); changed();
      try {
        const thing = await host.call('bridge.thing', {id}, {signal: detailRequest.signal});
        if (!stopped && current === detailGeneration) model.thing = thing;
      } catch (e) { if (!stopped && current === detailGeneration) model.detailError = describeFailure('bridge', e); }
      if (!stopped && current === detailGeneration) { model.detailLoading = false; changed(); }
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.close(); model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.things', {}, {signal});
        const things = (answer?.results ?? []).filter(r => r.thing?.type === 'product').map(r => r.thing);
        if (!stopped && current === generation) model.things = things;
      } catch (e) {
        if (!stopped && current === generation) { model.things = []; model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); detailRequest?.abort(); generation++; detailGeneration++; subscribers.clear(); },
  };
  return model;
}
