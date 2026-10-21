import {PageHeader} from './page-header.js';
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {RowList} from './rows.js';
import {CollectionSearch, useCollectionPage} from './collection-page.js';
import {Failure, PageState, StateBlock} from './page-state.js';
import {Avatar} from './avatar.js';
import {avatarOf} from '../people.js';
import {Glyph} from '../glyphs.js';
import {textsGroups} from '../texts.js';
import {joinText, plural} from '../format.js';
import {openable} from '../host/host.js';
import {EntityLink} from './entity-link.js';
const html = htm.bind(h);

// The Texts page (contract/host.md *Shared Texts mount*): a messaging page. Wide, the conversations at the left and the open one at the
// right (the shared conversation viewer, inline); narrow, the list, then the conversation over the whole screen. People first, then
// Businesses & alerts with their one-time codes folded into one row; one search over names and newest messages.
const textOf = row => joinText([row.title, row.from, row.person?.name, row.line], ' ');

/** A conversation's picture: the registry's portrait, else initials (a person, a group with names); a glyph for what has no name to
 *  take initials from: a code's lock, a number's phone (a group of numbers too), a business's store. */
function Picture({row, host}) {
  if (row.person || row.kind === 'person' && !row.numbered) return html`<${Avatar} host=${host} ...${row.person ? avatarOf(row.person, row.title) : {path: null, name: row.title}} />`;
  const glyph = row.code ? 'lock' : row.numbered ? 'phone' : 'store';
  return html`<span class="dp-tile" aria-hidden="true" data-glyph=${glyph}><${Glyph} name=${glyph} /></span>`;
}

function Row({row, open, host, onOpen}) {
  const go = ev => {
    // Mod+click, as Mod+Enter: the conversation in Google Messages
    const url = (ev.metaKey || ev.ctrlKey) && openable(row.document.url);
    return url ? host.call('url.open', {url}) : onOpen(row.document);
  };
  return html`<li><button type="button" class=${`dp-row dk-text-row${open ? ' sel' : ''}`} data-id=${row.id} aria-current=${open ? 'true' : null} title=${row.from ? `${row.title} · ${row.from}` : null}
      onClick=${go} onKeyDown=${ev => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(ev); } }}>
    <${Picture} row=${row} host=${host} />
    <span class="dp-lines">
      <span class="dk-text-head"><span class="dp-title">${row.title}</span>${row.when ? html`<time datetime=${row.at}>${row.when}</time>` : null}</span>
      <span class="dp-sub">${row.line}</span>
    </span>
  </button></li>`;
}

const Rows = ({rows, open, ...props}) => html`<ul class="dk-text-rows">${rows.map(row => html`<${Row} key=${row.id} ...${props} row=${row} open=${open === row.id} />`)}</ul>`;

function Group({id, title, count, children}) {
  return html`<section class="dk-texts-group" aria-labelledby=${id}><h2 class="dk-label" id=${id}>${title}<span>${count}</span></h2>${children}</section>`;
}

/** One-time codes: one row saying how many and when the newest came; open, each code's conversation. */
function Codes({rows, query, ...props}) {
  const newest = rows[0];
  return html`<details class="dk-texts-codes" open=${!!query || rows.some(row => row.id === props.open)}>
    <summary class="dp-row dk-text-row"><span class="dp-tile" aria-hidden="true"><${Glyph} name="lock" /></span>
      <span class="dp-lines"><span class="dk-text-head"><span class="dp-title">Verification codes</span>${newest?.when ? html`<time datetime=${newest.at}>${newest.when}</time>` : null}</span>
        <span class="dp-sub">${plural(rows.length, 'code')} hidden · ${rows.slice(0, 3).map(row => row.title).join(', ')}${rows.length > 3 ? ', …' : ''}</span></span>
      <${Glyph} name="next" size=${16} class="dk-texts-fold" /></summary>
    <${Rows} rows=${rows} ...${props} />
  </details>`;
}

/** `links`: its own pages (navigation.js pageLinks: the pairing pages, in the header's More), beside Refresh. */
export function Texts({model, host, onOpen, open = null, viewer = null, links = []}) {
  const page = useCollectionPage(model.items, {textOf, size: Number.MAX_SAFE_INTEGER, resetKey: 'texts'});
  const {people, businesses, codes} = textsGroups(page.filtered), rowProps = {host, onOpen, open};
  const listed = model.items.length && !model.error;
  // the open conversation's person (the registry's), linking to them
  const person = open ? model.items.find(row => row.id === open)?.person ?? null : null;
  const list = !listed
    ? html`<${RowList} host=${host} items=${[]} warming=${model.warming} loading=${model.loading ? 6 : 0}
        error=${model.error ? {error: model.error, title: 'Couldn’t load your texts', onAction: () => model.refresh()} : null}
        empty=${{title: 'No conversations yet', line: 'Texts from the phone show here once they sync.', glyph: 'chat'}} />`
    : html`<${PageState} state=${model.warming ? 'warming' : undefined} host=${host}>
      <${CollectionSearch} always=${true} page=${page} label="Search texts" placeholder="Names and messages" />
      ${page.filtered.length ? null : html`<${StateBlock} inline=${true} line=${`No conversations match “${page.query.trim()}”.`} />`}
      ${people.length ? html`<${Group} id="dk-texts-people" title="People" count=${people.length}><${Rows} rows=${people} ...${rowProps} /><//>` : null}
      ${businesses.length || codes.length ? html`<${Group} id="dk-texts-businesses" title="Businesses & alerts" count=${businesses.length + codes.length}>
        <${Rows} rows=${businesses} ...${rowProps} />${codes.length ? html`<${Codes} rows=${codes} query=${page.query} ...${rowProps} />` : null}<//>` : null}
      ${model.moreError ? html`<${Failure} error=${model.moreError} retry=${() => model.more()} host=${host} />` : null}
      ${model.next && !page.query ? html`<div class="dk-texts-more"><button type="button" class="dk-btn" disabled=${model.adding} onClick=${() => model.more()}>
        ${model.adding ? 'Loading more…' : 'More conversations'}</button></div>` : null}
    <//>`;
  return html`<main class="dk-texts dk-page" aria-label="Texts" data-open=${open ? '' : null} aria-busy=${model.loading ? 'true' : 'false'}>
    <${PageHeader} title="Texts" description="People first, then businesses and alerts." links=${links}
      actions=${html`<button class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <div class=${`dk-texts-panes${listed || viewer ? '' : ' alone'}`}>
      <section class="dk-texts-list" aria-label="Conversations">${list}</section>
      ${listed || viewer ? html`<section class="dk-texts-open" aria-label="Conversation">${viewer && person?.id != null
        ? html`<p class="dk-texts-person">With <${EntityLink} kind="person" id=${person.id} label=${person.name ?? 'this person'} host=${host} chip=${true} /></p>` : null}${viewer
        ?? html`<${StateBlock} glyph="chat" title="Choose a conversation" line="Its messages show here." />`}</section>` : null}
    </div>
  </main>`;
}
