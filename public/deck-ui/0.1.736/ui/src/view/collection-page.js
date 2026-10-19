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

/** Search all loaded metadata before slicing. Detail keys reset local filters; live refresh retains the current page. */
export function useCollectionPage(records = [], {textOf = collectionText, size = 40, resetKey, view, key = 'list'} = {}) {
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
  return {size, filtered, items: filtered.slice(start, end), query: state.query, page, pages, total, start, end,
    setQuery(query) { setSaved({key: resetKey, query: String(query), page: 0}); },
    turn(next) { setSaved({key: resetKey, query: state.query, page: Math.max(0, Math.min(pages - 1, Math.trunc(next)))}); }};
}

export function CollectionSearch({page, label, placeholder = 'Search names and details', loading = false, error = null}) {
  if (page.size <= 20 && page.pages <= 1 && !page.query && !loading && !error) return null;
  return h('div', {class: 'dk-collection-tools'},
    h('label', {class: 'dk-collection-search'}, h('span', {}, label), h('input', {type: 'search', class: 'dk-field',
      'aria-label': label, value: page.query, placeholder, onInput: event => page.setQuery(event.currentTarget.value)})),
    h('p', {role: 'status', 'data-collection-range': ''}, error ? 'Results unavailable' : loading ? 'Loading…' : page.total ? `${page.total.toLocaleString()} results · ${page.start + 1}–${page.end}` : 'No matches'));
}
export function CollectionPager({page, label = 'Collection pages'}) {
  if (page.pages <= 1) return null;
  return h('nav', {class: 'dk-collection-pager', 'aria-label': label},
    h('button', {type: 'button', class: 'dk-btn', disabled: page.page === 0, onClick: () => page.turn(page.page - 1)}, 'Previous page'),
    h('span', {}, `Page ${page.page + 1} of ${page.pages}`),
    h('button', {type: 'button', class: 'dk-btn', disabled: page.page === page.pages - 1, onClick: () => page.turn(page.page + 1)}, 'Next page'));
}
