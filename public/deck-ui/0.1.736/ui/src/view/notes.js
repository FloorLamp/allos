import {PageState} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {PageHeader} from './page-header.js';
import {Markdown} from './markdown.js';

export function Notes({model: m, host}) {
  const note = m.note;
  const blocked = !m.items?.length || [401, 403].includes(m.error?.status);
  const retry = () => { m.refresh(); m.flush(); };
  return h('main', {class: 'dk-page dk-notes', 'aria-label': 'Notes'},
    h(PageHeader, {title: 'Notes', description: 'Quick jottings, saved as you write.', actions: h('button', {class: 'dk-btn', disabled: m.loading, onClick: () => m.newNote()}, 'New note')}),
    h('p', {role: 'status'}, m.error ? 'Changes kept on this device. Retry when connected.' : m.saving ? 'Saving…' : Object.keys(m.pending).length ? 'Changes queued' : 'Saved'),
    h('button', {class: 'dk-btn', onClick: () => { m.refresh(); m.flush(); }}, 'Refresh / retry'),
    !blocked && m.error ? h(PageState, {error: m.error, host, retry}) : null,
    h(PageState, {state: m.loading && !m.items?.length ? 'loading' : undefined, error: blocked ? m.error : null, host, retry},
    h('div', {class: 'dn-layout'},
      h('section', {'aria-label': 'Note list'},
        h('input', {class: 'dk-field dn-search', type: 'search', 'aria-label': 'Search notes', placeholder: 'Search notes', value: m.query, onInput: e => m.search(e.target.value)}),
        h(PageState, {state: !m.visible.length ? 'empty' : undefined, hint: m.query ? 'Try another search.' : 'Create a note to start writing.'}),
        ...m.visible.map(n => h('button', {key: n.id, class: 'dk-btn dn-row', 'aria-current': n.id === m.selected ? 'true' : undefined, onClick: () => m.open(n.id)},
          h('strong', {}, n.title || n.text.split('\n')[0] || 'Untitled note'), h('time', {dateTime: n.updated_at}, new Date(n.updated_at).toLocaleString())))),
      note ? h('section', {'aria-label': 'Note'},
        h('button', {class: 'dk-btn', onClick: () => m.toggleEdit()}, m.editing ? 'View note' : 'Edit note'),
        m.editing ? h('textarea', {class: 'dn-editor', 'aria-label': 'Note text', value: note.text, onInput: e => m.edit(e.target.value), placeholder: 'Write a note. Use # headings, - lists and [links](https://…).'} )
          : h('article', {class: 'dn-body'}, h(Markdown, {text: note.text, host}))) : h(PageState, {state: 'empty', hint: 'Choose a note or create one.'}))));
}
