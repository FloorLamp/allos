// Projects (contract/flightplan.md *Projects*): flightplan's summary sentence over one line per active project, its verdict a dot;
// a line opens its epic on the Board. Compact wherever it shows: its own mount (mountProjects) and the Find landing, above Recent.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useReducer, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {boardPath, boardUrl, createProjects, verdictTone} from '../../projects.js';
import {RowList, readableDates} from '../rows.js';

import {useFold} from './fold.js';
import {Section} from './section.js';
import {Row} from './row.js';
import {More} from './more.js';
const html = htm.bind(h);

/** Opens a line's epic on the Board: `inPage` (a page beside the Board: the site, the Android app) here (Mod: a new tab), else (a
 *  desktop's palette) the site in the OS browser. */
export const boardOpener = (host, inPage) => (it, {page = false} = {}) => {
  const id = it.project?.id ?? null;
  if (!inPage) return host.call('url.open', {url: boardUrl(id)}).catch(() => {});
  if (page) window.open(boardPath(id), '_blank', 'noopener'); else location.assign(boardPath(id));
};

/** The Find landing's section (the empty box, above Recent): read each time the box empties, kept while a query shows; the first
 *  LANDING projects, then `+N more on the Board` (owner, 2026-10-17: the whole list buried Recent). */
export const LANDING = 3;
export function LandingProjects({host, platform, idle, fold, quiet = true}) {
  const [model] = useState(() => createProjects(host));
  const [, redraw] = useReducer(n => n + 1, 0);
  useEffect(() => { const off = model.subscribe(redraw); return () => { off(); model.stop(); }; }, [model]);
  useEffect(() => { if (idle) model.refresh(); }, [idle]);
  return idle ? html`<${Projects} model=${model} host=${host} fold=${fold} quiet=${quiet} limit=${LANDING} onOpen=${boardOpener(host, host.kind === 'web' || platform === 'android')} />` : null;
}

/** model: projects.js `createProjects`; `onOpen(project, {page})`; `quiet`: a failure or a first read shows nothing (the Find landing);
 *  `limit`: that many lines, then `+N more on the Board` (opens the Board, through `onOpen` with no project). */
function FoldedProjects(props) {
  const fold = useFold(props.host);
  return html`<${Projects} ...${props} fold=${fold} />`;
}
export function Projects({model, host, onOpen, quiet = false, limit = Infinity, p, fold}) {
  if (!fold && host) return html`<${FoldedProjects} model=${model} host=${host} onOpen=${onOpen} quiet=${quiet} limit=${limit} p=${p} />`;
  if (p !== undefined) {
    if (!p) return null;
    return html`<${Section} id="projects" label="Projects" count=${`${p.rows.length + p.more}`} fold=${fold}>
      <p class="dg-projects-summary">${p.summary}</p>
      ${p.rows.slice(0, limit).map(r => html`<${Row} key=${r.id} kind="project" row=${{text: readableDates(r.line), url: r.url, tone: r.tone}} onOpen=${onOpen} />`)}
      <${More} n=${p.more + Math.max(0, p.rows.length - limit)} url=${p.url} onOpen=${onOpen} what="on the Board" /></${Section}>`;
  }
  if (quiet && !model.loaded) return null;
  return html`<${Section} id="projects" label="Projects" class="dk-projects" fold=${fold} count=${model.projects.length} aria-busy=${model.loading ? 'true' : 'false'}>
    ${model.loaded ? html`<p class="dk-projects-summary">${model.summary}</p>` : null}
    <${RowList} host=${host} error=${model.error && !quiet ? {backend: 'flightplan', error: model.error, onAction: () => model.refresh()} : null} empty=${quiet ? undefined : {title: 'Create a project on the Board to track its progress.'}} loading=${!model.loaded && !model.error ? 2 : 0} onOpen=${onOpen}
      items=${model.projects.slice(0, limit).map(p => ({id: p.id, glyph: null, dot: verdictTone(p.verdict), title: readableDates(p.line), project: p}))} />
    ${model.projects.length > limit ? html`<button type="button" class="dk-btn text dk-projects-more" onClick=${e => onOpen({project: null}, {page: e.metaKey || e.ctrlKey})}>
      +${model.projects.length - limit} more on the Board</button>` : null}
  </${Section}>`;
}
