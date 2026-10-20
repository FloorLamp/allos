import {dateTimeText} from '../format.js';
import {Failure, PageState, StateBlock} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {PageHeader} from './page-header.js';
import {Markdown} from './markdown.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';

// its first line as words: a Markdown heading's marks left out (`# Garden` → `Garden`)
const noteTitle = n => (n.title || n.text.split('\n')[0] || '').replace(/^\s*#+\s*/, '').trim() || 'Untitled note';
const noteText = n => `${n.title ?? ''}\n${n.text}`;

/** Notes as every Library page: the shared search, rows and pager over the notes, newest first; a note opens in the drawer
 *  (read, or edit with autosave). States: loading, starting, signed out or failed (with Sign in or Retry) and empty, each once. */
export function Notes({model: m, host}) {
  const note = m.note;
  const page = useCollectionPage(m.sorted, {textOf: noteText});
  const retry = () => { m.refresh(); m.flush(); };
  // a read that failed: the page's state when nothing is kept here or it was refused (signed out, not allowed: drafts go too);
  // otherwise a line above the notes kept on this device
  const blocking = !!m.error && (!m.items.length || [401, 403].includes(m.error.status));
  // what this session's edits are doing: nothing to say until one is made
  const kept = !!m.saveError && Object.keys(m.pending).length > 0;
  const status = kept ? '' : m.saving ? 'Saving…' : Object.keys(m.pending).length ? 'Changes queued' : m.saved ? 'Saved' : '';
  const keptState = kept ? h(StateBlock, {inline: true, warn: true, line: 'Changes kept on this device. Retry when connected.', action: 'Retry', onAction: () => m.flush()}) : null;
  return h('main', {class: 'dk-page dk-notes', 'aria-label': 'Notes', 'aria-busy': m.loading},
    h(PageHeader, {title: 'Notes', description: 'Quick jottings, saved as you write.', actions: h('button', {class: 'dk-btn', disabled: m.loading, onClick: () => m.newNote()}, 'New note')}),
    !note && !blocking ? keptState : null,
    m.error && !blocking ? h(Failure, {error: m.error, host, retry}) : null,
    h(CollectionSearch, {page, label: 'Search notes'}),
    h(RowList, {card: true, host, warming: m.warming, loading: m.loading && !m.items.length ? 3 : 0, current: m.selected,
      error: blocking ? {error: m.error, onAction: retry} : null,
      items: page.items.map(n => ({id: n.id, glyph: 'note', title: noteTitle(n), sub: dateTimeText(n.updated_at, {now: new Date()})})),
      empty: page.query ? {title: 'No notes match', line: 'Try another search.'} : {title: 'No notes yet', line: 'Create a note to start writing.', glyph: 'note'},
      onOpen: row => m.open(row.id)}),
    h(CollectionPager, {page, label: 'Note pages'}),
    h(Drawer, {open: !!note, title: note ? noteTitle(note) : '', onClose: () => m.select(null)}, note ? h('section', {class: 'dn-note', 'aria-label': 'Note'},
      h('div', {class: 'dn-tools'},
        h('button', {class: 'dk-btn', onClick: () => m.toggleEdit()}, m.editing ? 'View note' : 'Edit note'),
        h('span', {class: 'dn-status', role: 'status'}, status)),
      keptState,
      m.editing ? h('textarea', {class: 'dn-editor', 'aria-label': 'Note text', value: note.text, onInput: e => m.edit(e.target.value), placeholder: 'Write a note. Use # headings, - lists and [links](https://…).'})
        : note.text.trim() ? h('article', {class: 'dn-body'}, h(Markdown, {text: note.text, host}))
        : h(PageState, {inline: true, state: 'empty', hint: 'Nothing written yet. Edit the note to start.'})) : null));
}
