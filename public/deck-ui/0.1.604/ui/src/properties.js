import {readBridge} from './host/host.js';
import {describeFailure} from './failure.js';
import {createCollectionDates} from './collection-dates.js';
// Property identity and paper membership come only from bridge's Properties projection.
export const propertyQuery = q => /^(properties|property|homes?)$/i.test(String(q).trim());
const label = key => String(key ?? '').toLowerCase().replace(/[_-]/g, ' ');
export function paperDates(document) {
  const entries = [...(document?.facts ?? []).map(f => ({name: f.key, value: f.value})), ...(document?.fields ?? []),
    ...Object.entries(document?.edited ?? {}).map(([name, value]) => ({name, value}))];
  const read = pattern => entries.filter(f => pattern.test(label(f.name))).at(-1)?.value || null;
  return {expiry: read(/^(expiry|expiration|expiry date|expiration date|expires|policy end|term end)$/),
    renewal: read(/^(renewal|renewal date|renewal due|renewal status)$/)};
}
export function propertyRow(property) {
  return {id: property.id, title: property.name, glyph: 'document',
    sub: [...new Set((property.papers ?? []).map(p => p.kind).filter(Boolean))].join(' · '),
    end: null, property};
}
export function createProperties(host) {
  let stopped = false, generation = 0, request, detailId = null, detailQueued = false;
  const subscribers = new Set();
  const changed = () => { if (!stopped) for (const fn of subscribers) fn(); };
  const detailChanged = () => {
    if (detailQueued) return;
    detailQueued = true;
    queueMicrotask(() => { detailQueued = false; changed(); });
  };
  const dates = createCollectionDates(host, {read: paperDates, changed: () => {
    const home = model.homes.find(home => home.id === detailId);
    if (home) home.papers = dates.decorate(home.papers ?? []);
    model.detailLoading = dates.loading;
    model.warning = dates.error ? describeFailure('bridge', dates.error) : null;
    detailChanged();
  }});
  const model = {
    homes: [], warming: false, loading: false, detailLoading: false, error: null, warning: null,
    async open(id) {
      detailId = id;
      model.warning = null; model.detailLoading = false;
      const home = model.homes.find(p => p.id === id);
      detailChanged();
      if (stopped) return;
      await dates.show([]);
      if (!stopped && detailId === id && home) home.papers = dates.decorate(home.papers ?? []);
    },
    visible(papers) { if (!stopped) return dates.show(papers); },
    retryDates() { if (!stopped) return dates.retry(); },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh({property = null} = {}) {
      if (stopped) return;
      model.open(null);
      dates.clear();
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.warming = false; model.loading = true; model.error = null; model.warning = null; changed();
      try {
        const answer = property ? {results: [{property}]} : await readBridge(host, 'bridge.properties', {}, {signal,
          snapshot: answer => { if (model.homes.length) return; model.homes = (answer?.results ?? []).filter(r => r.property).map(r => ({...r.property})); changed(); },
          warming: () => { if (!signal.aborted) { model.warming = true; changed(); } },
        });
        const homes = (answer?.results ?? []).filter(r => r.property).map(r => ({...r.property}));
        if (!stopped && current === generation) model.homes = homes;
      } catch (e) {
        if (!stopped && current === generation) { model.homes = []; model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.warming = false; model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); dates.stop(); generation++; subscribers.clear(); },
  };
  return model;
}
