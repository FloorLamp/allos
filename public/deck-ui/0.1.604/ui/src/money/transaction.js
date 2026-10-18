// Ported unchanged from Purser f334243; values remain text children.
// Transaction content; values are text children so imported text stays escaped.
export function transactionContent(h, t, { money, day }) {
  const field = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
  const history = (r) => h('section', {}, h('h3', {}, `Lineage · #${r.id}`),
    h('p', {}, `Status: ${r.status}`),
    r.parent_id ? h('p', {}, `Split parent: #${r.parent_id}`) : null,
    r.merged_into ? h('p', {}, `Merged into: #${r.merged_into}`) : null,
    r.merged.length ? h('p', {}, `Merged transactions: ${r.merged.map((id) => `#${id}`).join(', ')}`) : null,
    r.sources.length ? h('ul', {}, ...r.sources.map((s) => h('li', { key: s.raw },
      `${s.source} · import #${s.import_id} · raw #${s.raw} · ${s.role} · ${s.state} · matched by ${s.matched_by}${s.score === null ? '' : ` · score ${s.score}`}`)))
      : h('p', {}, 'No direct sources'),
    ...r.edits.map((e, i) => h('p', { key: i }, `${e.at} · ${e.by} · ${e.field}: ${e.value}`)));
  const details = (r) => h('dl', {}, field('Amount', money(r.amount_cents)), field('Payee', r.description || '(no payee)'),
    field('Date', day(r.date)), field('Account', r.account.name), field('Category', r.category?.name ?? 'Uncategorized'),
    field('Category reason', r.why?.text ?? 'nothing yet'), field('Notes', r.notes || 'No notes'),
    field('Tags', r.tags.length ? r.tags.join(', ') : 'No tags'), r.pending ? field('Posting', 'Pending') : null);
  return h('div', {}, details(t),
    t.counterparts.length ? h('section', {}, h('h3', {}, 'Transfer counterpart'),
      ...t.counterparts.map((r) => h('div', { key: r.id }, details(r), history(r))))
      : t.tags.includes('external') ? h('p', {}, 'Transfer counterpart: external') : null,
    t.split_lines.length ? h('section', {}, h('h3', {}, 'Split lines'),
      ...t.split_lines.map((r) => h('div', { key: r.id }, details(r), history(r)))) : null,
    history(t));
}

// The selected merge target survives; choices come from the current filtered list.
export function transactionActions(h, t, { money, day, saving, into, confirmDelete, candidates, onInto, onConfirmDelete, change }) {
  return h('section', { 'aria-label': 'Owner actions' },
    h('label', {}, h('input', { type: 'checkbox', checked: t.tags.includes('excluded'), disabled: saving,
      onChange: (ev) => change('excluded', { excluded: ev.currentTarget.checked }) }), ' Not in reports'),
    h('form', { onSubmit: (ev) => { ev.preventDefault(); if (!saving && into) return change('merge', { into: Number(into) }); } },
      h('label', {}, 'Merge into (keep this transaction)', h('select', { value: into, disabled: saving,
        onChange: (ev) => onInto(ev.currentTarget.value) },
      h('option', { value: '' }, 'Choose from the current list'),
      ...candidates.map((r) => h('option', { key: r.id, value: String(r.id) },
        `#${r.id} · ${day(r.date)} · ${r.description || '(no payee)'} · ${r.account.name} · ${money(r.amount_cents)}`)))),
      h('p', {}, 'This transaction will be merged into the selected transaction. Its sources will move to the survivor.'),
      h('button', { type: 'submit', disabled: saving || !into }, 'Merge')),
    confirmDelete ? h('div', {}, h('p', {}, 'Delete this transaction? Its history will be kept.'),
      h('button', { type: 'button', disabled: saving, onClick: () => change('status', { status: 'deleted' }) }, 'Confirm delete'),
      h('button', { type: 'button', disabled: saving, onClick: () => onConfirmDelete(false) }, 'Cancel'))
      : h('button', { type: 'button', disabled: saving, onClick: () => onConfirmDelete(true) }, 'Delete'));
}
