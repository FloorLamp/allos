import {PageHeader} from './page-header.js';
import {h} from '../../vendor/preact.mjs';
import {RowList} from './rows.js';

export function Texts({model, host, onOpen}) {
  return h('main', {class: 'dk-texts dk-page', 'aria-label': 'Texts'},
    h(PageHeader, {title: 'Texts', description: 'Conversations and messages.',
      actions: h('button', {class: 'dk-btn', disabled: model.loading, onClick: () => model.refresh()}, 'Refresh')}),
    h(RowList, {host, warming: model.warming, items: model.items, loading: model.loading && !model.items.length ? 3 : 0,
      error: model.error ? {error: model.error, onAction: () => model.refresh()} : null,
      empty: {title: 'No conversations yet', glyph: 'chat'},
      onOpen: (row, {page}) => page && row.document.url ? host.call('url.open', {url: row.document.url}) : onOpen(row.document)}),
    model.next ? h('button', {class: 'dk-btn', disabled: model.loading, onClick: () => model.refresh(true)}, model.loading ? 'Loading…' : 'More conversations') : null);
}
