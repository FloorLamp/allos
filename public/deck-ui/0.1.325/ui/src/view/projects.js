import {h} from '../../vendor/preact.mjs';
import {useState} from '../../vendor/hooks.mjs';
import {RowList} from './rows.js';
import {Failure} from './failure.js';
import {openMap} from './map.js';

export function Projects({model, host, onOpen}) {
  const [filter, setFilter] = useState('');
  const shown = model.clusters.filter(p => `${p.name} ${p.kind} ${p.summary}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return h('main', {class: 'dk-projects', 'aria-label': 'Clusters'},
    h('h1', {}, 'Clusters'),
    h('label', {}, 'Filter clusters ', h('input', {class: 'dk-field', value: filter, onInput: e => setFilter(e.currentTarget.value)})),
    h('label', {}, h('input', {type: 'checkbox', checked: model.all, onChange: e => { model.all = e.currentTarget.checked; model.refresh(); }}), ' Include set-aside clusters'),
    h('button', {class: 'dk-btn', disabled: model.loading, onClick: () => model.refresh()}, 'Refresh'),
    model.error ? h(Failure, {backend: 'bridge', error: model.error, host, retry: () => model.id ? model.select(model.id) : model.refresh()}) : null,
    h(RowList, {items: shown.map(p => ({id: p.id, title: p.name || '(unnamed)', sub: [p.kind, p.state, `${p.count} documents`, p.from, p.to, p.summary].filter(Boolean).join(' · ')})),
      loading: model.loading ? 3 : 0, empty: {title: model.clusters.length ? 'No cluster matches' : 'No clusters yet'}, onOpen: row => model.select(row.id)}),
    model.detailLoading ? h('p', {role: 'status'}, 'Loading cluster…') : null,
    model.detail ? h(Cluster, {key: model.detail.cluster.id + model.detail.cluster.name, model, host, onOpen}) : null);
}

function Cluster({model, host, onOpen}) {
  const {cluster: p, documents = [], out = []} = model.detail;
  const [name, setName] = useState(p.name), [picked, setPicked] = useState([]), [split, setSplit] = useState(''), [into, setInto] = useState('');
  const button = (label, action, disabled = false) => h('button', {class: 'dk-btn', disabled: model.busy || disabled, onClick: action}, label);
  return h('section', {'aria-label': 'Cluster details'},
    button('Back to clusters', () => model.select(null)),
    h('h2', {}, p.name), h('p', {}, p.summary),
    h('label', {}, 'Name ', h('input', {class: 'dk-field', value: name, onInput: e => setName(e.currentTarget.value)})),
    button('Rename', () => model.edit('rename', {name: name.trim()}), !name.trim()),
    button(p.state === 'active' ? 'Not a cluster' : 'It is a cluster', () => model.edit(p.state === 'active' ? 'remove' : 'restore')),
    button('Map', () => openMap(host, {by: 'cluster', value: p.id, label: p.name})),
    h('label', {}, 'Merge into ', h('select', {class: 'dk-field', value: into, onChange: e => setInto(e.currentTarget.value)},
      h('option', {value: ''}, 'Choose cluster'), model.clusters.filter(c => c.id !== p.id && c.state === 'active').map(c => h('option', {value: c.id}, c.name)))),
    button('Confirm merge', () => model.edit('merge', {clusters: [p.id]}, into), !into),
    h('h3', {}, 'Documents'),
    h(RowList, {items: documents.map(document => ({id: document.id, document})), checkable: true, checked: picked,
      onCheck: (id, on) => setPicked(on ? [...picked, id] : picked.filter(x => x !== id)), onOpen: row => onOpen(row.document), empty: {title: 'No indexed documents'}}),
    button('Take out', () => { model.edit('remove-members', {ids: picked}); setPicked([]); }, !picked.length),
    h('label', {}, 'New cluster name ', h('input', {class: 'dk-field', value: split, onInput: e => setSplit(e.currentTarget.value)})),
    button('Split selected', () => { model.edit('split', {ids: picked, name: split.trim()}); setPicked([]); }, !picked.length || !split.trim()),
    h('h3', {}, 'Taken out'),
    h(RowList, {items: out.map(document => ({id: document.id, document, end: {label: 'Put back', onClick: () => model.edit('add-members', {ids: [document.id]})}})), onOpen: row => onOpen(row.document), empty: {title: 'No documents taken out'}}));
}
