import {physicalThingId} from './physical-thing.js';
import {dateText, fieldLabel} from './format.js';
import {amountText} from './quantity.js';
import {readableFacts} from './readable-facts.js';
import {describeFailure} from './failure.js';
// Use Bridge's name, dropping later clauses of verbose purchase titles.
// Bound even titles without punctuation, keeping the full name in the detail.
export function thingName(t) {
  const name = String(t.name ?? '').trim();
  const clause = name.split(/[,;|]|\s+[–—-]\s+/u)[0].trim();
  return clause.length <= 80 ? clause : `${clause.slice(0, 77).replace(/\s+\S*$/, '')}…`;
}
export const thingRow = t => ({id: t.id, title: thingName(t), glyph: t.type === 'plant' ? 'plant' : 'thing',
  sub: [...new Set([t.brand, t.model, t.variant?.size, t.variant?.colour, t.person?.name, t.store, t.purchaseDate ? dateText(t.purchaseDate) : null, amountText(t.price)].filter(Boolean))].join(' · ') || 'No purchase details indexed'});
export function createThings(host) {
  let stopped = false, generation = 0, request, detailRequest, detailGeneration = 0;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    things: [], loading: false, warming: false, error: null, id: null, thing: null, detailLoading: false, detailError: null,
    close() { detailRequest?.abort(); detailGeneration++; model.id = null; model.thing = null; model.detailLoading = false; model.detailError = null; changed(); },
    async open(id) {
      if (stopped) return;
      model.close(); model.id = id;
      if (physicalThingId(id)) { changed(); return; }
      model.detailLoading = true;
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
      model.close(); model.warming = false; model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.things', {}, {signal,
          onWarming: () => { if (!signal.aborted) { model.warming = true; changed(); } },
        });
        const things = (answer?.results ?? []).filter(r => r.thing?.type === 'product' && r.thing.status === 'owned').map(r => r.thing);
        if (!stopped && current === generation) model.things = things;
      } catch (e) {
        if (!stopped && current === generation) { model.error = describeFailure('bridge', e); if (model.error.state !== 'warming') model.things = []; }
      }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); detailRequest?.abort(); generation++; detailGeneration++; subscribers.clear(); },
  };
  return model;
}

/** Cached product properties and catalog metadata as readable drawer facts. */
export function thingSpecs(thing) {
  const specs = {...thing.specs};
  for (const [key, value] of Object.entries({brand: thing.brand, model: thing.model,
    size: thing.variant?.size, colour: thing.variant?.colour})) {
    if (value != null && String(value).trim()) specs[key] = value;
  }
  return Object.entries(specs).flatMap(([key, value]) => key === 'properties'
    ? (Array.isArray(value) ? value.filter(p => p && typeof p.name === 'string' && p.name.trim())
      .flatMap(p => readableFacts(p.value, p.name.trim())) : [])
    : readableFacts(value, fieldLabel(key)));
}
