import {dateRange, dateText, fieldLabel, plural} from '../format.js';
import {clusterName} from '../clusters.js';
import {PageHeader} from './page-header.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import {RowList, docLine} from './rows.js';
import {Failure} from './page-state.js';
import {RecordCard} from './record-card.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
import {ProductTile} from './product-tile.js';
import {amountText} from '../quantity.js';
const clusterText = cluster => [cluster.name, cluster.kind, cluster.summary, stateLabel(cluster.state), cluster.from, cluster.to].join(' ');
// the owner's word for a cluster that is not one: set aside (bridge's `removed`), as the list's checkbox says
const stateLabel = state => !state || state === 'active' ? null : state === 'removed' ? 'Set aside' : fieldLabel(state);
// a cluster's things (bridge's cluster detail `things: {count, results}`: what its orders bought, newest purchase first, one per
// product); owned says nothing (Things lists owned ones)
const thingsOf = detail => detail.things?.results ?? [];
const thingStatus = t => t.status && t.status !== 'owned' ? fieldLabel(t.status) : null;
const thingText = t => [t.name, t.store, thingStatus(t), amountText(t.price), t.purchaseDate].join(' ');
const thingKey = (t, i) => String(t.thingId ?? t.id ?? i);
/** A thing's page: its house record (`thingId`), else its catalog product's; null for neither. */
const thingTarget = t => t.thingId || t.id ? {collection: 'things', id: String(t.thingId ?? t.id)} : null;
const CARD_THINGS = 4;

/** `onRecord(target)`: a thing's page; `onPage({cluster | document | record})` one in a new tab. */
export function Clusters({model, host, onOpen, onRecord, onPage, navigation, view}) {
  const [selected, select] = usePageSelection(navigation), list = useRef(null), [editing, setEditing] = useState(false);
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
  // the open cluster stays in its place while it is open, set aside or not
  const opened = model.detail?.cluster, shown = opened && model.id === opened.id && !listPage.items.some(c => c.id === opened.id)
    ? [{...opened, ...model.clusters.find(c => c.id === opened.id)}, ...listPage.items] : listPage.items;
  return h('main', {class: 'dk-clusters dk-page', 'aria-label': 'Clusters'},
    h(PageHeader, {title: 'Clusters', description: 'Documents gathered around one undertaking. Your edits survive the next sync.', actions: h('button', {class: 'dk-btn', disabled: model.loading, onClick: () => model.refresh()}, 'Refresh')}),
    h('div', {class: 'dc-tools'},
      h(CollectionSearch, {page: listPage, label: 'Filter clusters'}),
      h('label', {class: 'dc-check'}, h('input', {type: 'checkbox', checked: model.all, onChange: e => { model.all = e.currentTarget.checked; model.refresh(); }}), ' Include set-aside clusters')),
    h('div', {ref: list}, h(RowList, {card: true, host, warming: model.warming, error: !model.id && model.error ? {error: model.error, onAction: () => model.refresh()} : null, items: shown.map(p => ({id: p.id, cluster: {...p, name: clusterName(p) || '(unnamed)'},
      notes: stateLabel(p.state) ? [{text: stateLabel(p.state), tone: 'warn'}] : []})), current: model.id,
      loading: model.loading && !model.clusters.length ? 3 : 0, empty: {title: model.clusters.length ? 'No cluster matches' : 'No clusters yet'},
      onOpen: (row, {page}) => page ? onPage?.({cluster: row.id}) : onSelect(row.id),
      onClose: () => onSelect(null),
      // its card; Edit (the owner's) its curation in the card, in place: rename, set aside, take out, split, merge
      // (an edit's refresh keeps the card drawn, its fields focused; a refused one says so in it)
      expand: row => {
        if (row.id !== model.id) return null;
        const failure = model.error ? h(Failure, {backend: 'bridge', error: model.error, host, retry: () => model.select(model.id)}) : null;
        if (!model.detail || model.detail.cluster.id !== row.id) return failure ?? h('p', {class: 'dk-note', role: 'status'}, 'Loading cluster…');
        return h(ClusterCard, {key: row.id, detail: model.detail, host, onOpen, onRecord, onFull: navigation ? () => navigation.openRecord(row.id) : null,
          edit: host.caps?.clusters === true ? {on: editing, toggle: () => setEditing(!editing)} : null},
          failure, editing ? h(ClusterDetail, {key: row.id, model, host, onOpen, onRecord, onPage, view, inCard: true}) : null);
      }})),
    h(CollectionPager, {page: listPage, label: 'Cluster pages'}));
}

/** A cluster opened in place (the shared record card): what it is, its summary, up to four of its things (`onRecord(target)` a thing's
 *  page), its newest documents; `edit` {on, toggle} the owner's Edit, `children` (the curation, while editing) in place of the documents. */
export function ClusterCard({detail, host, onOpen, onRecord, onFull, edit = null, children = null}) {
  const {cluster: p, documents = []} = detail;
  const newest = edit?.on ? [] : [...documents].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const things = thingsOf(detail), shownThings = Math.min(things.length, CARD_THINGS);
  return h(RecordCard, {label: p.name, onOpen: onFull, actions: edit ? [{label: edit.on ? 'Done' : 'Edit', onClick: edit.toggle}] : [],
    // the things first, then fewer documents beside them
    limit: shownThings + (shownThings ? 3 : 5),
    facts: [{label: 'Kind', value: p.kind ? fieldLabel(p.kind) : null}, {label: 'State', value: stateLabel(p.state)}, {label: 'Documents', value: String(p.count ?? documents.length)},
      {label: 'When', value: dateRange(p.from, p.to) || null}, {label: 'Named', value: p.namedBy === 'owner' ? 'By you' : 'By the model'}],
    groups: [{key: 'things', title: 'Things', total: detail.things?.count ?? things.length, max: CARD_THINGS, items: things.map((t, i) => ({id: thingKey(t, i), title: t.name,
      sub: [amountText(t.price), thingStatus(t)].filter(Boolean).join(' · '), date: t.purchaseDate, when: dateText(t.purchaseDate),
      tile: h(ProductTile, {host, image: t.image, size: 14}), onOpen: thingTarget(t) && onRecord ? () => onRecord(thingTarget(t)) : null}))},
    {key: 'documents', title: 'Documents', total: p.count ?? documents.length, items: newest.map(d => ({id: d.id, title: d.title, date: d.date, when: dateText(d.date), glyph: 'document', link: {kind: 'document', id: d.id}, onOpen: () => onOpen?.(d)}))}]},
    p.summary ? h('p', {class: 'dk-card-text'}, p.summary) : null, children);
}

/** `inCard`: inside its record card, which already says what it is and its things (its line, summary and Things left out);
 *  `onRecord(target)` a thing's page. */
export function ClusterDetail({model, host, onOpen, onRecord, onPage, view, inCard = false}) {
  const {cluster: p, documents = [], out = []} = model.detail;
  const editable = host.caps?.clusters === true;
  const [draft, updateDraft] = useState(() => view?.clusterDraft?.id === p.id ? view.clusterDraft : {id: p.id, name: p.name, picked: [], split: '', into: ''});
  const {name, picked, split, into} = draft;
  const change = (key, value) => updateDraft(previous => { const next = {...previous, [key]: value}; if (view) view.clusterDraft = next; return next; });
  const setName = value => change('name', value), setPicked = value => change('picked', value), setSplit = value => change('split', value), setInto = value => change('into', value);
  const previousName = useRef(p.name);
  const things = inCard ? [] : thingsOf(model.detail);
  const thingPage = useCollectionPage(things, {size: 20, textOf: thingText, resetKey: p.id, view, key: 'cluster-things'});
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
    inCard ? null : h('p', {class: 'dc-meta'}, [p.kind ? fieldLabel(p.kind) : null, stateLabel(p.state), plural(p.count ?? documents.length, 'document'),
      dateRange(p.from, p.to), p.namedBy === 'owner' ? 'edited by you' : 'named by the model'].filter(Boolean).join(' · ')),
    p.summary && !inCard ? h('p', {}, p.summary) : null,
    // what it bought, under what it is and above its curation and papers (a part with nothing in it is left out)
    things.length ? h('section', {class: 'dc-things', 'aria-label': 'Things'}, h('h3', {}, 'Things'),
      h(CollectionSearch, {page: thingPage, label: 'Search cluster things'}),
      h(RowList, {host, items: thingPage.items.map((t, i) => ({id: thingKey(t, i), title: t.name, thing: t, tile: h(ProductTile, {host, image: t.image}),
        sub: [amountText(t.price), dateText(t.purchaseDate), t.store].filter(Boolean).join(' · '), notes: thingStatus(t) ? [{text: thingStatus(t)}] : []})),
        onOpen: (row, {page} = {}) => { const target = thingTarget(row.thing); if (target) (page ? onPage?.({record: target}) : onRecord?.(target)); },
        empty: {title: 'No things match'}}),
      h(CollectionPager, {page: thingPage, label: 'Cluster thing pages'})) : null,
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
    h(CollectionPager, {page: removedPage, label: 'Taken-out document pages'}),
    // the owner's curation of the cluster itself, last: the page reads what it is, its things, its documents
    editable ? h('section', {class: 'dc-edit', 'aria-label': 'Edit cluster'}, h('h3', {}, 'Edit'),
      h('form', {class: 'dc-name', onSubmit: rename},
        h('label', {}, 'Name', h('input', {class: 'dk-field', value: name, readOnly: model.busy, onInput: e => setName(e.currentTarget.value)})),
        h('button', {type: 'submit', class: 'dk-btn', disabled: model.busy || !name.trim() || name.trim() === p.name}, 'Rename')),
      h('div', {class: 'dc-actions'},
        button(p.state === 'active' ? 'Not a cluster' : 'It is a cluster', () => model.edit(p.state === 'active' ? 'remove' : 'restore'))),
      h(CollectionSearch, {page: mergePage, label: 'Find merge destination'}),
      h('div', {class: 'dc-merge'}, h('label', {}, 'Merge into', h('select', {class: 'dk-field', disabled: model.busy, value: into, onChange: e => setInto(e.currentTarget.value)},
        h('option', {value: ''}, 'Choose cluster'), mergeOptions.map(c => h('option', {key: c.id, value: c.id}, c.name)))),
        button('Confirm merge', () => { const target = validMergeTarget(); if (target) model.edit('merge', {clusters: [p.id]}, target.id); }, !mergeTarget)),
      h(CollectionPager, {page: mergePage, label: 'Merge destination pages'})) : null);
}
