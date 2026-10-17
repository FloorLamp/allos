import {h} from '../../vendor/preact.mjs';
import {RowList} from './rows.js';

export function Attention({model, onOpen}) {
  const {tab} = model;
  const docs = tab === 'ignored' ? model.ignored : model.items.filter(d => d.kind === tab);
  const items = tab === 'gaps' ? model.gaps.map(g => ({id: g.id, title: `${g.label}: ${g.period}`, sub: g.cadence,
    end: {label: 'Dismiss', onClick: () => model.mutate('gap', [g.id])}}))
    : tab === 'coverage' ? model.coverage.map((c, n) => ({id: n, title: `${c.source} ${c.account ?? ''}`, sub: `${c.year}: ${c.read} read, ${c.indexed} kept`}))
      : docs.map(d => ({id: d.id, document: {...d, title: d.title || d.sourceId},
        notes: (d.problems ?? []).map(p => ({text: [p.reason, p.name].filter(Boolean).join(' · ')})),
        end: {label: tab === 'ignored' ? 'Restore' : 'Dismiss', onClick: () => model.mutate(tab === 'ignored' ? 'restore' : 'dismiss', [d.id])}}));
  return h('main', {class: 'dk-attention', 'aria-label': 'Attention'},
    h('h1', {}, 'Attention'),
    h('nav', {'aria-label': 'Attention sections'}, ['locked', 'unsupported', 'gaps', 'coverage', 'ignored'].map(t =>
      h('button', {class: 'dk-btn', 'aria-current': tab === t ? 'page' : undefined, onClick: () => model.setTab(t)}, t))),
    h('button', {class: 'dk-btn', disabled: model.loading || model.busy, onClick: () => model.refresh()}, 'Refresh'),
    h(RowList, {items, loading: model.loading ? 3 : 0,
      error: model.error ? {error: model.error, onAction: () => model.refresh()} : null,
      empty: {title: 'Nothing needs attention'}, onOpen: row => { if (row.document) onOpen(row.document); }}),
    ['locked', 'unsupported'].includes(tab) ? docs.map(d => h('form', {onSubmit: event => {
      event.preventDefault(); const input = event.currentTarget.elements.password;
      const password = input.value; input.value = ''; model.mutate('retry', [d.id], password);
    }}, h('label', {}, `Read again: ${d.title || d.sourceId}`, h('input', {name: 'password', type: 'password', autoComplete: 'off', placeholder: 'PDF password (used once)'})),
    h('button', {class: 'dk-btn', disabled: model.busy}, 'Read again'))) : null);
}
