export const paperSearchText = paper => [paper.kind, paper.document?.title, paper.document?.type, paper.document?.date, paper.document?.source].filter(Boolean).join(' ');
export const paperDateText = paper => paper.datesUnavailable ? 'Dates unavailable' : paper.expiry ? `Expires ${paper.expiry}`
  : paper.datesLoaded ? 'Expiry not indexed' : paper.datesLoading ? 'Loading dates…' : 'Dates not checked';

/** Optional document dates: only one visible 20-paper page, four native/API reads at a time, cached by document identity. */
export function createCollectionDates(host, {read, changed = () => {}}) {
  const cache = new Map(), active = new Set();
  let visible = [], stopped = false, batch = null;
  const done = entry => entry?.state === 'ready' || entry?.state === 'failed';
  const notify = () => {
    if (stopped) return;
    if (batch && visible.every(key => done(cache.get(key)))) batch.resolve();
    changed();
  };
  const pump = () => {
    if (stopped) return;
    for (const key of visible) {
      if (active.size >= 4) break;
      const entry = cache.get(key);
      if (!entry || entry.state !== 'queued') continue;
      entry.state = 'loading'; entry.request = new AbortController(); active.add(entry);
      (async () => {
        try {
          const document = await host.call('bridge.doc', {id: entry.id}, {signal: entry.request.signal});
          if (!stopped && !entry.request.signal.aborted && cache.get(key) === entry) {
            entry.value = {...read(document), datesUnavailable: false}; entry.state = 'ready';
          }
        } catch (error) {
          if (!stopped && !entry.request.signal.aborted && cache.get(key) === entry) {
            entry.value = {datesUnavailable: true}; entry.error = error; entry.state = 'failed';
          }
        } finally {
          active.delete(entry);
          if (entry.request.signal.aborted && cache.get(key) === entry) cache.delete(key);
          pump(); notify();
        }
      })();
    }
  };
  const model = {
    get loading() { return visible.some(key => !done(cache.get(key))); },
    get error() { return visible.map(key => cache.get(key)?.error).find(Boolean) ?? null; },
    decorate(papers) { return papers.map(paper => {
      const entry = cache.get(String(paper.document?.id));
      if (!entry) return paper.datesLoading ? {...paper, datesLoading: false} : paper;
      const value = {...entry.value, datesLoaded: done(entry), datesLoading: entry.state === 'loading' || entry.state === 'queued', datesUnavailable: entry.state === 'failed'};
      return Object.entries(value).every(([key, value]) => paper[key] === value) ? paper : {...paper, ...value};
    }); },
    show(papers = []) {
      if (stopped) return Promise.resolve();
      const docs = new Map(papers.slice(0, 20).filter(paper => paper.document?.id != null).map(paper => [String(paper.document.id), paper.document.id]));
      const keys = [...docs.keys()];
      if (batch && keys.length === visible.length && keys.every((key, i) => key === visible[i])) return batch.promise;
      batch?.resolve(); visible = keys;
      for (const entry of active) if (!docs.has(String(entry.id))) {
        entry.request.abort();
        if (cache.get(String(entry.id)) === entry) cache.delete(String(entry.id));
      }
      for (const [key, id] of docs) if (!cache.has(key)) cache.set(key, {id, state: 'queued'});
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      batch = {promise, resolve};
      pump(); notify();
      return promise;
    },
    retry() {
      const papers = visible.map(key => ({document: {id: cache.get(key).id}}));
      for (const key of visible) if (cache.get(key)?.state === 'failed') cache.delete(key);
      batch = null;
      return model.show(papers);
    },
    clear() { batch?.resolve(); batch = null; visible = []; for (const entry of active) entry.request.abort(); cache.clear(); },
    stop() { stopped = true; model.clear(); },
  };
  return model;
}
