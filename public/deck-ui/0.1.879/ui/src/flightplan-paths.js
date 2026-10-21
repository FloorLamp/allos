// Flightplan's page URLs (contract/flightplan.md *Pages*), the same on every host that serves Deck's pages: Todo at `/todo`
// (`/todo/<list>`), the Board at `/flightplan` (its filters a readable query), an item's drawer at `…/FP-<id>`, a change at
// `/flightplan/change/<owner>/<repo>/<n>`. No DOM; the mounts read and write them (mounts/flightplan.js).

export const TODO = '/todo', BOARD = '/flightplan';
/** Board filters in the query, in this order. */
const FILTERS = ['project', 'priority', 'area', 'label', 'q'];
const ref = /^FP-([1-9]\d{0,15})$/;
const idOf = segment => (m => m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : null)(ref.exec(segment ?? ''));
const segments = (path, root) => path === root || path.startsWith(`${root}/`)
  ? path.slice(root.length).split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } }) : null;

/** A project's slug in a Board URL: its title's words, lower case, joined by `-` (`Garden planner v1` → `garden-planner-v1`). */
export const projectSlug = title => String(title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** `/todo`, `/todo/<list>`, either with `/FP-<id>` (its drawer). The default view (Needs you, today and upcoming) is `/todo`. */
export function todoPath({list = null, id = null} = {}) {
  return `${TODO}${list && list !== 'all' ? `/${encodeURIComponent(list)}` : ''}${id != null ? `/FP-${id}` : ''}`;
}
/** A Todo path's list (`all` for `/todo` and `/todo/today`) and drawer item; null when the path is not Todo's. */
export function parseTodo(path) {
  const parts = segments(path, TODO);
  if (!parts || parts.length > 2) return null;
  const id = idOf(parts.at(-1)), lists = id == null ? parts : parts.slice(0, -1);
  if (lists.length > 1) return null;
  return {list: !lists.length || lists[0] === 'today' ? 'all' : lists[0], id};
}

/** `/flightplan`, `/flightplan/FP-<id>` or `/flightplan/change/<owner>/<repo>/<n>`, with the Board's filters as its query
 *  (`project` a slug, `priority` `P0`–`P3` or `none`, `area`, `label`, `q`); `keep` carries other query parameters through. */
export function boardPath({id = null, change = null, filters = {}, keep = null} = {}) {
  const path = change ? `${BOARD}/change/${change.repo.split('/').map(encodeURIComponent).join('/')}/${change.pr}` : `${BOARD}${id != null ? `/FP-${id}` : ''}`;
  const query = new URLSearchParams();
  for (const [key, value] of keep ?? []) if (!FILTERS.includes(key)) query.append(key, value);
  for (const key of FILTERS) if (filters[key]) query.set(key, filters[key]);
  const q = query.toString().replace(/=(?=&|$)/g, '');
  return q ? `${path}?${q}` : path;
}
/** A Board URL's drawer item, change and filters; null when the path is not the Board's. */
export function parseBoard(path, search = '') {
  const parts = segments(path, BOARD);
  if (!parts) return null;
  const query = new URLSearchParams(search), filters = {};
  for (const key of FILTERS) { const v = query.get(key)?.trim(); if (v) filters[key] = v; }
  if (filters.priority && !/^(P[0-3]|none)$/.test(filters.priority)) delete filters.priority;
  if (parts[0] === 'change') {
    const [, owner, repo, n] = parts;
    return parts.length === 4 && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) && /^[1-9]\d*$/.test(n)
      ? {id: null, change: {repo: `${owner}/${repo}`, pr: Number(n)}, filters} : {id: null, change: null, filters};
  }
  return {id: parts.length === 1 ? idOf(parts[0]) : null, change: null, filters};
}

/** An item's own page on the site: work (with a repo) on the Board, the owner's on Todo. */
export const itemPath = item => item?.repo ? boardPath({id: item.id}) : todoPath({id: item.id});
export const SITE = 'https://deck.wang.team';
export const siteUrl = path => `${SITE}${path}`;
