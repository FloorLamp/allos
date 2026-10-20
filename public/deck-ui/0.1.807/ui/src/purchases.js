import {describeFailure} from './failure.js';

// Category identity and order/charge joins belong to bridge; Deck never guesses a match. Pages follow bridge's opaque cursors: `starts`
// holds the cursor each page begins at, so Previous returns to a page already seen; the total is unknown (`more`: a next page exists).
const LIMIT = 40;
export function createPurchases(host) {
  let generation = 0, stopped = false, request, starts = [null];
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  async function load(category, page) {
    if (stopped) return;
    request?.abort(); request = new AbortController();
    const current = ++generation, cursor = starts[page];
    const {signal} = request;
    model.category = category; model.page = page; model.loading = true; model.warming = false; model.error = null; changed();
    try {
      const answer = await host.call('bridge.purchases', {query: {limit: LIMIT, ...(category ? {category} : {}), ...(cursor ? {cursor} : {})}}, {signal,
        onWarming: () => { if (!signal.aborted && current === generation) { model.warming = true; changed(); } }});
      if (!stopped && current === generation) {
        model.results = answer.results; model.categories = answer.categories ?? [];
        starts = [...starts.slice(0, page + 1), ...(answer.nextCursor ? [answer.nextCursor] : [])];
        model.more = !!answer.nextCursor;
      }
    } catch (e) {
      if (!stopped && current === generation) { model.results = []; model.more = false; model.error = describeFailure('bridge', e); }
    }
    if (!stopped && current === generation) { model.loading = false; model.warming = false; changed(); }
  }
  const model = {
    // nothing answered yet reads as loading: the page never says empty before bridge does
    results: [], categories: [], category: '', page: 0, more: false, loading: true, warming: false, error: null, size: LIMIT,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    /** Reloads the page shown; another category starts at its first page. */
    refresh({category = model.category} = {}) {
      if (category !== model.category) starts = [null];
      return load(category, category === model.category ? model.page : 0);
    },
    /** Another page: one already seen, or the next. */
    turn(page) { return page >= 0 && page < starts.length ? load(model.category, page) : Promise.resolve(); },
    stop() { stopped = true; generation++; request?.abort(); subscribers.clear(); },
  };
  return model;
}
