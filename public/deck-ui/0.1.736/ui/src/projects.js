// How the projects are going (contract/flightplan.md *Projects*): flightplan's `/v1/projects` through the host's registry op
// (`flightplan.projects`), by rule with no model call: a summary sentence and one line per active project, its verdict a dot. No DOM
// here (view/projects.js draws it).

/** Each verdict's dot (foundation.css `dot-*`) and words, as flightplan's `line` says them. */
export const VERDICTS = {
  done: {tone: 'ok', words: 'done'},
  'waiting-on-you': {tone: 'warn', words: 'waiting on you'}, stuck: {tone: 'bad', words: 'stuck'}, moving: {tone: 'ok', words: 'on track'},
  idle: {tone: 'muted', words: 'idle'}, 'not-split': {tone: 'muted', words: 'not split yet'}};
export const verdictTone = verdict => VERDICTS[verdict]?.tone ?? 'muted';
/** The epic on the Board: the site's and the Android app's page (both at deck.wang.team). */
export const boardPath = id => (id == null ? '/flightplan#board' : `/flightplan?epic=${encodeURIComponent(id)}#board`);
export const boardUrl = id => `https://deck.wang.team${boardPath(id)}`;

/** host: Deck's host. Fetched on `refresh()`; no timer. */
export function createProjects(host) {
  const listeners = new Set();
  let request = null, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    summary: '', projects: [], loaded: false, loading: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {
      if (stopped) return;
      request?.abort();
      const mine = request = new AbortController();
      model.loading = true; notify();
      try {
        const r = await host.call('flightplan.projects', {}, {signal: mine.signal});
        if (stopped || mine.signal.aborted) return;
        Object.assign(model, {summary: r?.summary ?? '', projects: Array.isArray(r?.projects) ? r.projects : [], loaded: true, error: null});
      } catch (error) { if (!stopped && !mine.signal.aborted) model.error = error; }
      finally { if (!stopped && !mine.signal.aborted) { model.loading = false; notify(); } }
    },
    stop() { stopped = true; request?.abort(); listeners.clear(); },
  };
  return model;
}
