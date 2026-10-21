// The one list inside a record's full view (Papers, Vehicles, Properties, Insurance, People, …): a section heading with its count,
// the list's search past one page, rows that open on click or Enter (no second "Open" pill), newest first, repeats folded, the pager.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {countText, dateText} from '../format.js';
import {SectionHead} from './drawer.js';
import {RowList} from './rows.js';
import {foldRepeats} from './record-card.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
const html = htm.bind(h);

const newestFirst = items => [...items].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
const rowText = item => [item.title, item.sub, item.badge?.text].filter(Boolean).join(' ');

/** items [{id, title, sub?, date?, glyph?, badge?, ...}] (`sub` defaults to the date); `onOpen(item)`; `sorted` keeps the caller's
 *  order; `note` a quiet line under the list (what is not indexed); `listKey` and `resetKey` keep its search and page per detail
 *  (useCollectionPage); `onVisible(items)` hears which rows the page shows (to load their dates). Items alike (the same title and date)
 *  are one row with their count (`×6`: it opens the newest, its count shows them all). No items: no section (its note alone, if any). */
export function DetailList({title, items = [], onOpen, note = null, view, listKey, resetKey, sorted = false, level = 3, size = 20, actions = null, onVisible}) {
  const [shown, setShown] = useState(() => new Set());
  const rows = foldRepeats((sorted ? items : newestFirst(items)).map(item => ({glyph: 'document', ...item, sub: item.sub ?? (item.date ? dateText(item.date) : null)})));
  const page = useCollectionPage(rows, {size, textOf: rowText, resetKey, view, key: listKey ?? title});
  const visible = page.items.map(item => item.id).join(',');
  useEffect(() => { onVisible?.(page.items.flatMap(item => item.members ?? [item])); }, [visible, resetKey]);
  useEffect(() => { setShown(new Set()); }, [resetKey]);
  if (!items.length) return note ? html`<p class="dk-note dk-detail-note">${note}</p>` : null;
  const toggle = id => setShown(previous => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next; });
  const listed = page.items.flatMap(item => !item.count ? [item] : [
    {...item, end: {label: `×${item.count}`, aria: shown.has(item.id) ? `Hide the ${item.count} alike` : `Show all ${item.count}`, expanded: shown.has(item.id), onClick: () => toggle(item.id)}},
    ...(shown.has(item.id) ? item.members.map((m, k) => ({...m, id: `${item.id}:${k}`, glyph: null, oneLine: true})) : [])]);
  return html`<section class="dk-section dk-detail-list" aria-label=${title}>
    <${SectionHead} level=${level} title=${title} meta=${countText(items.length)} actions=${actions} />
    <${CollectionSearch} page=${page} label=${`Search ${title.toLowerCase()}`} />
    <${RowList} inline=${true} items=${listed} onOpen=${onOpen} empty=${{title: 'No matches'}} />
    <${CollectionPager} page=${page} label=${`${title} pages`} />
    ${note ? html`<p class="dk-note">${note}</p>` : null}
  </section>`;
}
