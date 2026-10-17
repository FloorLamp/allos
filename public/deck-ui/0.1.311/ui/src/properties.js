import {describeFailure} from './failure.js';
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
  let stopped = false, generation = 0, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    homes: [], loading: false, error: null, warning: null,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const {signal} = request, current = ++generation;
      model.loading = true; model.error = null; model.warning = null; changed();
      try {
        const answer = await host.call('bridge.properties', {}, {signal});
        const documents = new Map();
        const homes = await Promise.all((answer?.results ?? []).filter(r => r.property).map(async ({property}) => ({...property,
          papers: await Promise.all((property.papers ?? []).map(async paper => {
            const id = paper.document?.id;
            if (!id) return {...paper};
            if (!documents.has(id)) documents.set(id, host.call('bridge.doc', {id}, {signal}).catch(e => { if (!stopped && current === generation) model.warning = describeFailure('bridge', e); return null; }));
            const detail = await documents.get(id);
            return {...paper, ...paperDates(detail), datesUnavailable: !detail};
          })),
        })));
        if (!stopped && current === generation) model.homes = homes;
      } catch (e) {
        if (!stopped && current === generation) { model.homes = []; model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); generation++; subscribers.clear(); },
  };
  return model;
}
