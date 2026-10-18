import {createProjects} from '../projects.js';
import {Projects, boardOpener} from '../view/sections/projects.js';
import {h, render} from '../../vendor/preact.mjs';
import {drawing} from '../mount-runtime.js';

/** How the projects are going (contract/flightplan.md *Projects*): flightplan's summary and a line per project. opts.onOpen(project,
 *  {page}) overrides opening its epic on the Board (`/flightplan?epic=<id>#board` in this page; Mod: a new tab). Fetched now and on
 *  `refresh()`; no timer. Answers {projects, refresh(), unmount()}. */
export function mountProjects(el, host, opts = {}) {
  const projects = createProjects(host);
  const onOpen = opts.onOpen ? (it, how) => opts.onOpen(it.project, how) : boardOpener(host, true);
  const d = drawing(el, 'Projects', () => render(h(Projects, {model: projects, host, onOpen}), el));
  projects.subscribe(() => d.draw());
  projects.refresh();
  return {projects, refresh: () => projects.refresh(), unmount() { projects.stop(); d.unmount(); }};
}
