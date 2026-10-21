import {countText, plural} from '../format.js';
import {h} from '../../vendor/preact.mjs';
import {useMemo, useState} from '../../vendor/hooks.mjs';
import {pageRange} from '../collection-window.js';

// Friendly metadata only. Never traverse document bodies, message histories or arbitrary payloads.
const SEARCH_FIELDS = ['name', 'title', 'kind', 'type', 'state', 'status', 'summary', 'scope', 'relation', 'organisation', 'vendor', 'role',
  'make', 'model', 'year', 'aliases', 'person', 'insured', 'vehicles', 'home', 'store', 'brand', 'purchaseDate', 'renewal', 'expiry', 'from', 'to', 'date', 'term', 'source'];
export function collectionText(value, depth = 0) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || depth > 3) return '';
  if (Array.isArray(value)) return value.map(item => collectionText(item, depth + 1)).join(' ');
  return SEARCH_FIELDS.map(key => collectionText(value[key], depth + 1)).join(' ');
}
const normalized = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Rows a list shows at a time: a collection's page, a backend-paged list's step (Money's More). */
export const PAGE_SIZE = 40;

/** Search all loaded metadata before slicing. Detail keys reset local filters; live refresh retains the current page. */
export function useCollectionPage(records = [], {textOf = collectionText, size = PAGE_SIZE, resetKey, view, key = 'list'} = {}) {
  const empty = () => ({key: resetKey, query: '', page: 0});
  const [local, setLocal] = useState(empty);
  const saved = view ? view.collectionPages?.[key] ?? empty() : local;
  const state = saved.key === resetKey ? saved : empty();
  const setSaved = next => {
    if (view) { view.collectionPages ??= {}; view.collectionPages[key] = next; }
    setLocal(next);
  };
  const index = useMemo(() => records.map(record => normalized(textOf(record))), [records, textOf]);
  const filtered = useMemo(() => {
    const words = normalized(state.query).trim().split(/\s+/).filter(Boolean);
    return words.length ? records.filter((_, i) => words.every(word => index[i].includes(word))) : records;
  }, [records, index, state.query]);
  const {total, pages, page, start, end} = pageRange(filtered.length, state.page, size);
  return {size, count: records.length, filtered, items: filtered.slice(start, end), query: state.query, page, pages, total, start, end,
    setQuery(query) { setSaved({key: resetKey, query: String(query), page: 0}); },
    turn(next) { setSaved({key: resetKey, query: state.query, page: Math.max(0, Math.min(pages - 1, Math.trunc(next)))}); }};
}

/** The one search of a list (`page` from useCollectionPage): shown once the list runs past one page or 20 records, or a
 *  query is typed, so never over a list's loading, starting, failed or empty state. Its status is only the count; a search that matches
 *  nothing is said by the list's empty state. A page with its own search (Money's server filters) passes none. */
export function CollectionSearch({page, label, placeholder = 'Search names and details', always = false, children = null}) {
  if (!always && !page.query && page.pages <= 1 && page.count <= 20) return null;
  // `always` where the search is the server's (People: names, aliases, contacts); `children` its filters (a select) after the field
  return h('div', {class: 'dk-collection-tools'},
    h('label', {class: 'dk-collection-search'}, h('span', {}, label), h('input', {type: 'search', class: 'dk-field',
      'aria-label': label, value: page.query, placeholder, onInput: event => page.setQuery(event.currentTarget.value)})), children,
    h('p', {role: 'status', 'data-collection-range': ''}, !page.total ? '' : page.pages > 1 ? `${plural(page.total, 'result')} · ${page.start + 1}–${page.end}` : plural(page.total, 'result')));
}
/** `page` from useCollectionPage, or a backend's cursor pages: `{page, pages: null, more, busy, turn, start?, end?}` (the total unknown,
 *  `more` a next cursor exists; `busy` while one loads; `start`–`end` the rows shown, said as `1–40` (one row: `41`) in place of `Page 1`). Cursor
 *  pages show Previous only past the first page and Next only with a next cursor. */
export function CollectionPager({page, label = 'Collection pages'}) {
  const known = page.pages != null, last = known ? page.page >= page.pages - 1 : !page.more;
  if (page.page === 0 && last) return null;
  const turn = (text, to, disabled) => h('button', {type: 'button', class: 'dk-btn', disabled: disabled || page.busy, onClick: () => page.turn(to)}, text);
  return h('nav', {class: `dk-collection-pager${known ? '' : ' cursor'}`, 'aria-label': label},
    known || page.page > 0 ? turn('Previous page', page.page - 1, page.page === 0) : null,
    h('span', {}, known ? `Page ${page.page + 1} of ${page.pages}` : page.end > page.start + 1 ? `${countText(page.start + 1)}–${countText(page.end)}` : page.end > page.start ? countText(page.end) : `Page ${page.page + 1}`),
    known || !last ? turn('Next page', page.page + 1, last) : null);
}
