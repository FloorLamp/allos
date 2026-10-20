import {dateRange, dateText, fieldLabel, plural} from '../format.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import {RowList, docLine} from './rows.js';
import {Failure} from './page-state.js';
import {Drawer} from './drawer.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const clusterText = cluster => [cluster.name, cluster.kind, cluster.summary, stateLabel(cluster.state), cluster.from, cluster.to].join(' ');
// the owner's word for a cluster that is not one: set aside (bridge's `removed`), as the list's checkbox says
const stateLabel = state => !state || state === 'active' ? null : state === 'removed' ? 'Set aside' : fieldLabel(state);

export function Clusters({model, host, onOpen, onPage, navigation, view}) {
  const [selected, select] = usePageSelection(navigation), list = useRef(null);
  const focusRow = id => [...(list.current?.querySelectorAll('[data-id]') ?? [])].find(row => row.dataset.id === id)?.focus({preventScroll: true});
  const onSelect = id => {
    const previous = model.id;
    if (id) focusRow(id);
    if (navigation) select(id); else model.select(id);
    if (!id) queueMicrotask(() => focusRow(previous));
  };
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active && navigation && model.id !== selected) model.select(selected); });
    return () => { active = false; };
  }, [navigation, selected]);
  const listPage = useCollectionPage(model.clusters, {textOf: clusterText, view, key: 'list'});
  // the drawer's title while its detail loads or fails: the listed name
  const name = model.detail?.cluster.name ?? model.clusters.find(c => c.id === model.id)?.name ?? 'Cluster';
  return h('main', {class: 'dk-clusters dk-page', 'aria-label': 'Clusters'},
    h(PageHeader, {title: 'Clusters', description: 'Documents gathered around one undertaking. Your edits survive the next sync.', actions: h('button', {class: 'dk-btn', disabled: model.loading, onClick: () => model.refresh()}, 'Refresh')}),
    h('div', {class: 'dc-tools'},
      h(CollectionSearch, {page: listPage, label: 'Filter clusters'}),
      h('label', {class: 'dc-check'}, h('input', {type: 'checkbox', checked: model.all, onChange: e => { model.all = e.currentTarget.checked; model.refresh(); }}), ' Include set-aside clusters')),
    h('div', {ref: list}, h(RowList, {card: true, host, warming: model.warming, error: !model.id && model.error ? {error: model.error, onAction: () => model.refresh()} : null, items: listPage.items.map(p => ({id: p.id, cluster: {...p, name: p.name || '(unnamed)'},
      notes: stateLabel(p.state) ? [{text: stateLabel(p.state), tone: 'warn'}] : []})), current: model.id,
      loading: model.loading && !model.clusters.length ? 3 : 0, empty: {title: model.clusters.length ? 'No cluster matches' : 'No clusters yet'},
      onOpen: (row, {page}) => page ? onPage?.({cluster: row.id}) : onSelect(row.id)})),
    h(CollectionPager, {page: listPage, label: 'Cluster pages'}),
    h(Drawer, {key: model.id, open: !!model.id, title: name, label: name, onClose: () => onSelect(null)},
      model.error ? h(Failure, {backend: 'bridge', error: model.error, host, retry: () => model.select(model.id)}) : null,
      model.detailLoading ? h('p', {role: 'status'}, 'Loading cluster…') : null,
      model.detail ? h(ClusterDetail, {key: model.detail.cluster.id, model, host, onOpen, onPage, view}) : null));
}

export function ClusterDetail({model, host, onOpen, onPage, view}) {
  const {cluster: p, documents = [], out = []} = model.detail;
  const editable = host.caps?.clusters === true;
  const [draft, updateDraft] = useState(() => view?.clusterDraft?.id === p.id ? view.clusterDraft : {id: p.id, name: p.name, picked: [], split: '', into: ''});
  const {name, picked, split, into} = draft;
  const change = (key, value) => updateDraft(previous => { const next = {...previous, [key]: value}; if (view) view.clusterDraft = next; return next; });
  const setName = value => change('name', value), setPicked = value => change('picked', value), setSplit = value => change('split', value), setInto = value => change('into', value);
  const previousName = useRef(p.name);
  const documentPage = useCollectionPage(documents, {size: 20, resetKey: p.id, view, key: 'cluster-documents'});
  const removedPage = useCollectionPage(out, {size: 20, resetKey: p.id, view, key: 'cluster-removed'});
  const mergePage = useCollectionPage(model.clusters.filter(c => c.id !== p.id && c.state === 'active'), {textOf: clusterText, resetKey: p.id, view, key: 'cluster-merge'});
  const validMergeTarget = () => model.clusters.find(c => c.id === into && c.id !== p.id && c.state === 'active');
  const mergeTarget = validMergeTarget();
  const mergeOptions = into && mergeTarget && !mergePage.items.some(c => c.id === into) ? [mergeTarget, ...mergePage.items] : mergePage.items;
  useLayoutEffect(() => { if (previousName.current !== p.name) { previousName.current = p.name; setName(p.name); } }, [p.name]);
  const button = (label, action, disabled = false) => h('button', {type: 'button', class: 'dk-btn', disabled: model.busy || disabled, onClick: action}, label);
  const rename = event => { event.preventDefault(); if (editable && name.trim() && name.trim() !== p.name) model.edit('rename', {name: name.trim()}); };
  const members = async (action, payload) => { if (editable && await model.edit(action, payload)) setPicked([]); };
  const open = (row, {page}) => page ? onPage?.({document: row.document}) : onOpen(row.document);
  const source = row => host.call('document.page', {id: row.document.id, url: row.document.url ?? null}).catch(() => {});
  return h('section', {'aria-label': 'Cluster details', 'aria-busy': model.busy},
    h('p', {class: 'dc-meta'}, [p.kind ? fieldLabel(p.kind) : null, stateLabel(p.state), plural(p.count ?? documents.length, 'document'),
      dateRange(p.from, p.to), p.namedBy === 'owner' ? 'edited by you' : 'named by the model'].filter(Boolean).join(' · ')),
    p.summary ? h('p', {}, p.summary) : null,
    editable ? h('form', {class: 'dc-name', onSubmit: rename},
      h('label', {}, 'Name', h('input', {class: 'dk-field', value: name, readOnly: model.busy, onInput: e => setName(e.currentTarget.value)})),
      h('button', {type: 'submit', class: 'dk-btn', disabled: model.busy || !name.trim() || name.trim() === p.name}, 'Rename')) : null,
    editable ? h('div', {class: 'dc-actions'},
      button(p.state === 'active' ? 'Not a cluster' : 'It is a cluster', () => model.edit(p.state === 'active' ? 'remove' : 'restore'))) : null,
    editable ? h(CollectionSearch, {page: mergePage, label: 'Find merge destination'}) : null,
    editable ? h('div', {class: 'dc-merge'}, h('label', {}, 'Merge into', h('select', {class: 'dk-field', disabled: model.busy, value: into, onChange: e => setInto(e.currentTarget.value)},
      h('option', {value: ''}, 'Choose cluster'), mergeOptions.map(c => h('option', {key: c.id, value: c.id}, c.name)))),
      button('Confirm merge', () => { const target = validMergeTarget(); if (target) model.edit('merge', {clusters: [p.id]}, target.id); }, !mergeTarget)) : null,
    editable ? h(CollectionPager, {page: mergePage, label: 'Merge destination pages'}) : null,
    h('h3', {}, 'Documents'),
    h(CollectionSearch, {page: documentPage, label: 'Search cluster documents'}),
    h('fieldset', {class: 'dc-members', disabled: model.busy}, h(RowList, {items: documentPage.items.map(document => ({id: document.id, document,
      sub: [docLine(document), document.by === 'owner' ? 'added by you' : document.score != null ? `tie ${Math.round(document.score * 100)}%` : ''].filter(Boolean).join(' · ')})), checkable: editable, checked: editable ? picked : [],
      onCheck: editable ? (id, on) => setPicked(on ? [...picked, id] : picked.filter(x => x !== id)) : undefined, onOpen: open, onSource: source, empty: {title: documentPage.query ? 'No documents match' : 'No indexed documents'}})),
    h(CollectionPager, {page: documentPage, label: 'Cluster document pages'}),
    editable && picked.length ? h('p', {role: 'status'}, `${plural(picked.length, 'document')} selected across pages`) : null,
    editable ? h('div', {class: 'dc-actions'}, button('Take out', () => members('remove-members', {ids: picked}), !picked.length)) : null,
    editable ? h('div', {class: 'dc-split'}, h('label', {}, 'New cluster name', h('input', {class: 'dk-field', disabled: model.busy, value: split, onInput: e => setSplit(e.currentTarget.value)})),
      button('Split selected', () => members('split', {ids: picked, name: split.trim()}), !picked.length || !split.trim())) : null,
    h('h3', {}, 'Taken out'),
    h(CollectionSearch, {page: removedPage, label: 'Search taken-out documents'}),
    h(RowList, {items: removedPage.items.map(document => ({id: document.id, document,
      sub: [dateText(document.date), document.by === 'owner' ? 'by you' : 'by the model'].filter(Boolean).join(' · '),
      end: editable ? {label: 'Put back', disabled: model.busy, onClick: () => model.edit('add-members', {ids: [document.id]})} : null})), onOpen: open, onSource: source, empty: {title: removedPage.query ? 'No taken-out documents match' : 'No documents taken out'}}),
    h(CollectionPager, {page: removedPage, label: 'Taken-out document pages'}));
}
