// The one list inside a collection's detail drawer (Papers, Vehicles, Properties, Insurance, People, …): a section heading with
// its count, the list's search past one page, rows that open on click or Enter (no second "Open" pill), newest first, and the pager.
import {h} from '../../vendor/preact.mjs';
import {useEffect} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {countText, dateText} from '../format.js';
import {SectionHead} from './drawer.js';
import {RowList} from './rows.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
const html = htm.bind(h);

const newestFirst = items => [...items].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
const rowText = item => [item.title, item.sub, item.badge?.text].filter(Boolean).join(' ');

/** items [{id, title, sub?, date?, glyph?, badge?, ...}] (`sub` defaults to the date); `onOpen(item)`; `sorted` keeps the caller's
 *  order; `empty` the line when there is none; `note` a quiet line under the list (what is not indexed); `listKey` and `resetKey` keep
 *  its search and page per detail (useCollectionPage); `onVisible(items)` hears which rows the page shows (to load their dates). */
export function DetailList({title, items = [], onOpen, empty = 'None indexed', note = null, view, listKey, resetKey, sorted = false, level = 3, size = 20, actions = null, onVisible}) {
  const rows = (sorted ? items : newestFirst(items)).map(item => ({glyph: 'document', ...item, sub: item.sub ?? (item.date ? dateText(item.date) : null)}));
  const page = useCollectionPage(rows, {size, textOf: rowText, resetKey, view, key: listKey ?? title});
  const shown = page.items.map(item => item.id).join(',');
  useEffect(() => { onVisible?.(page.items); }, [shown, resetKey]);
  return html`<section class="dk-section dk-detail-list" aria-label=${title}>
    <${SectionHead} level=${level} title=${title} meta=${items.length ? countText(items.length) : null} actions=${actions} />
    <${CollectionSearch} page=${page} label=${`Search ${title.toLowerCase()}`} />
    ${rows.length ? html`<${RowList} inline=${true} items=${page.items} onOpen=${onOpen}
      empty=${{title: page.query ? 'No matches' : empty}} />` : html`<p class="dk-note">${empty}</p>`}
    <${CollectionPager} page=${page} label=${`${title} pages`} />
    ${note ? html`<p class="dk-note">${note}</p>` : null}
  </section>`;
}
