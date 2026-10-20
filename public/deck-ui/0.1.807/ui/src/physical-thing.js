import {describeFailure} from './failure.js';

export const physicalThingId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** One bridge read owns the join; never infer identity from names or model numbers. */
export function createPhysicalThing(host) {
  let request, generation = 0, stopped = false;
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };
  const model = {
    id: null, thing: null, loading: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async open(id) {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const current = ++generation;
      model.id = id; model.thing = null; model.error = null; model.loading = true; changed();
      try {
        if (!physicalThingId(id)) throw Error('invalid identity');
        const answer = await host.call('bridge.things.detail', {query: {id}}, {signal: request.signal});
        if (answer?.thing?.id?.toLowerCase() !== id.toLowerCase()) throw Error('identity mismatch');
        if (!stopped && generation === current) model.thing = answer.thing;
      } catch (error) {
        if (!stopped && generation === current) model.error = describeFailure('bridge', error);
      }
      if (!stopped && generation === current) { model.loading = false; changed(); }
    },
    stop() { stopped = true; generation++; request?.abort(); listeners.clear(); },
  };
  return model;
}
