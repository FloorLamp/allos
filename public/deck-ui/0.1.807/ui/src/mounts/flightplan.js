import {h, render} from '../../vendor/preact.mjs';
import {createFlightplan} from '../flightplan.js';
import {Flightplan} from '../view/flightplan.js';
import {drawing} from '../mount-runtime.js';
import {boardPath, parseBoard, projectSlug} from '../flightplan-paths.js';

/** The document's path and query as a page's state (flightplan-paths.js): a new place (a list, a drawer) pushes an entry, a
 *  refinement (a filter) replaces it; back and forward apply what they land on. Entries carry this instance's token: history.state
 *  survives a reload, and a reloaded page did not open the entry it shows. */
export function urlState(doc, apply) {
  const win = doc?.defaultView, token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const here = () => win ? `${win.location.pathname}${win.location.search}` : '';
  const go = (path, push) => {
    if (!win || path === here()) return;
    if (push) win.history.pushState({deckFlightplan: token}, '', path);
    else win.history.replaceState(win.history.state, '', path);
  };
  win?.addEventListener('popstate', apply);
  return {
    get path() { return win?.location.pathname ?? ''; },
    get search() { return win?.location.search ?? ''; },
    push: path => go(path, true),
    replace: path => go(path, false),
    /** Leave a drawer: back when this page opened it, else the page's own path in its place (a deep link, a reload: at once, where
     *  back's traversal lands later). */
    leave(path) { if (win?.history.state?.deckFlightplan === token) win.history.back(); else go(path, false); },
    stop() { win?.removeEventListener('popstate', apply); },
  };
}

/** Wraps `fp[name]`: what it does, then `after()` unless the URL is being applied. */
function after(fp, names, guard, then) {
  for (const name of names) {
    const own = fp[name].bind(fp);
    fp[name] = (...args) => { const r = own(...args); if (!guard()) then(name, args); return r; };
  }
}

/** Flightplan's Board (contract/flightplan.md *Pages*) on its own page, `/flightplan`: its filters the query (`project`, `priority`,
 *  `area`, `label`, `q`), an item's drawer `/flightplan/FP-<id>`, a change `/flightplan/change/<owner>/<repo>/<n>`. opts `brand`,
 *  `nav`, `current` (the nav bar), `clock`, `needsSource`. Fetched now, on `refresh()` and while visible. Answers
 *  {flightplan, refresh(), unmount()}. */
export function mountFlightplan(el, host, opts = {}) {
  const fp = createFlightplan(host, {clock: opts.clock, needsSource: opts.needsSource});
  const d = drawing(el, 'Flightplan', () => render(h(Flightplan, {model: fp, host, opts}), el));
  const own = {open: fp.open.bind(fp), close: fp.close.bind(fp), openChange: fp.openChange.bind(fp)};
  // `project`: the URL's slug; `waiting`: a slug the Board's projects have not resolved yet
  let applying = false, project = null, waiting = false;
  const url = urlState(el.ownerDocument, () => apply());
  const slugOf = id => (e => e ? projectSlug(e.epic.title) : null)(id == null ? null : fp.epics().find(e => e.epic.id === id));
  const filters = () => ({project: fp.epic != null ? slugOf(fp.epic) ?? project : null, priority: fp.priority || null, area: fp.area !== 'All' ? fp.area : null,
    label: fp.label || null, q: fp.query.trim() || null});
  const path = (drawer = fp.drawer) => boardPath({id: drawer && !drawer.item.changeOnly ? drawer.item.id : null,
    change: drawer?.item.changeOnly ? {repo: `${drawer.item.owner}/${drawer.item.repo}`, pr: drawer.item.pr} : null,
    filters: filters(), keep: new URLSearchParams(url.search)});
  fp.open = task => { own.open(task); if (!applying && fp.drawer) url.push(path()); };
  fp.close = () => { const was = fp.drawer; own.close(); if (!applying && was) url.leave(path(null)); };
  after(fp, ['setArea', 'setPriority', 'setLabel', 'setQuery', 'setEpic'], () => applying, name => { if (name === 'setEpic') waiting = false; if (!waiting) project = slugOf(fp.epic); url.replace(path()); });
  // A project's slug needs the projects: it applies once the Board has them.
  const resolve = () => {
    waiting = false;
    if (project == null) { if (fp.epic != null) fp.setEpic(null); return; }
    const e = fp.epics().find(x => projectSlug(x.epic.title) === project);
    if (!e) { waiting = !fp.board.loaded; return; }
    if (fp.epic !== e.epic.id) fp.setEpic(e.epic.id);
  };
  const apply = () => {
    applying = true;
    try {
      const r = parseBoard(url.path, url.search) ?? {id: null, change: null, filters: {}}, f = r.filters;
      if ((f.area ?? 'All') !== fp.area) fp.setArea(f.area ?? 'All');
      if ((f.priority ?? '') !== fp.priority) fp.setPriority(f.priority ?? '');
      if ((f.label ?? '') !== fp.label) fp.setLabel(f.label ?? '');
      if ((f.q ?? '') !== fp.query.trim()) fp.setQuery(f.q ?? '');
      project = f.project ?? null;
      resolve();
      if (r.change) {
        const [owner, repo] = r.change.repo.split('/'), key = `${r.change.repo}#${r.change.pr}`;
        if (fp.changeRoute !== key) { fp.changeRoute = key; own.openChange(owner, repo, r.change.pr); }
        return;
      }
      fp.changeRoute = null;
      if (r.id && fp.drawer?.item.id !== r.id) own.open({id: r.id, title: 'Loading item…', kind: 'task'});
      else if (!r.id && fp.drawer) own.close();
    } finally { applying = false; }
  };
  const off = fp.subscribe(() => { if (waiting && fp.board.loaded && !applying) { applying = true; try { resolve(); } finally { applying = false; } } });
  fp.setTab('board');
  apply();
  return {flightplan: fp, refresh: () => fp.refreshBoard(), unmount() { off(); url.stop(); fp.stop(); d.unmount(); }};
}
