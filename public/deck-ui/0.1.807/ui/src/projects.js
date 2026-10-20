// How the projects are going (contract/flightplan.md *Projects*): flightplan's `/v1/projects` through the host's registry op
// (`flightplan.projects`), by rule with no model call: a summary sentence and one line per active project, its verdict a dot. No DOM
// here (view/projects.js draws it).
import {boardPath, projectSlug, siteUrl} from './flightplan-paths.js';

/** Each verdict's dot (foundation.css `dot-*`) and words, as flightplan's `line` says them. */
export const VERDICTS = {
  done: {tone: 'ok', words: 'done'},
  'waiting-on-you': {tone: 'warn', words: 'waiting on you'}, stuck: {tone: 'bad', words: 'stuck'}, moving: {tone: 'ok', words: 'on track'},
  idle: {tone: 'muted', words: 'idle'}, 'not-split': {tone: 'muted', words: 'not split yet'}};
export const verdictTone = verdict => VERDICTS[verdict]?.tone ?? 'muted';
/** A project's line split at its verdict, for a row too narrow for the whole line: `text` the project, `sub` its verdict and progress
 *  onward (`on track · 2/6 · …`); a line without its verdict's words stays whole. */
export function projectLines(line, verdict) {
  const text = String(line ?? ''), words = VERDICTS[verdict]?.words, at = words ? text.indexOf(` · ${words}`) : -1;
  return at > 0 ? {text: text.slice(0, at), sub: text.slice(at + 3)} : {text, sub: ''};
}
/** A project's Board (`/flightplan?project=<slug>`; null: the whole Board): the site's and the Android app's page (both at deck.wang.team). */
export const projectPath = project => boardPath({filters: project?.title ? {project: projectSlug(project.title)} : {}});
export const projectUrl = project => siteUrl(projectPath(project));

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
