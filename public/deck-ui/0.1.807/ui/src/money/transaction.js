import {dateSection, dateTimeText, plural, sentence} from '../format.js';
import {money as moneyQuantity} from '../quantity.js';
import {categoryText, sourceText} from './labels.js';

// A transaction as every Money list shows it (Transactions, a merchant's page): its merchant (or payee), category and account, notes for
// what sets it apart, the amount trailing. `href` the row's address; `sections` false when the list is not sorted by date.
export function transactionRow(t, {href, sections = true} = {}) {
  const unsure = t.category_source === 'rule' && t.confidence < 0.8;
  return {
    id: String(t.id), glyph: null, section: sections ? dateSection(t.date) : null, title: transactionTitle(t),
    sub: [t.lines ? `Split · ${t.lines} lines` : categoryText(t.category?.name), t.account.name].join(' · '),
    notes: [...(t.pending ? [{ text: 'Pending', tone: 'warn' }] : []), ...(t.tags.includes('excluded') ? [{ text: 'Not in reports' }] : []),
      ...(t.transfer ? [] : t.tags.includes('external') ? [{ text: 'Transfer to an outside account' }] : []),
      ...(t.why?.by && t.why.by !== 'simplifi' ? [{ text: `${sentence(t.why.text)}${unsure ? ', unsure' : ''}`, tone: unsure ? 'warn' : '' }] : [])],
    quantity: moneyQuantity(t.amount_cents / 100), href,
  };
}

/** A transaction's name: a transfer's accounts, else its merchant, else its payee. */
export const transactionTitle = (t) => t.transfer ? `Transfer · ${t.transfer_accounts?.from ?? t.account.name} → ${t.transfer_accounts?.to ?? 'external'}`
  : t.merchant?.name || t.description || '(no payee)';

// Tags Purser keeps for itself; the drawer says what they mean instead.
const INTERNAL = new Set(['excluded', 'external', 'split']);
const by = (who) => (who === 'owner' || who === 'user' ? 'You' : sentence(who));

/** One edit in words: `You set the category to Food › Groceries`. categories: the facets' tree (id → path). */
export function editText(e, categories = []) {
  const path = (id) => categoryText(categories.find((c) => String(c.id) === String(id))?.path ?? null);
  const what = {
    category_id: () => e.value == null || e.value === '' ? 'cleared the category' : `set the category to ${path(e.value)}`,
    notes: () => e.value ? 'changed the notes' : 'cleared the notes',
    tags: () => (String(e.value ?? '').includes('"excluded"') ? 'left it out of reports' : 'put it back in reports'),
    status: () => (e.value === 'deleted' ? 'deleted it' : `marked it ${e.value}`),
    merged_into: () => 'merged it into another transaction',
    description: () => 'renamed the payee',
    merchant_id: () => 'changed its merchant',
  }[e.field];
  return `${by(e.by)} ${what ? what() : `changed ${e.field.replaceAll('_', ' ')}`}`;
}

// Transaction content; values are text children so imported text stays escaped.
export function transactionContent(h, t, { money, day, categories = [] }) {
  const field = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
  // where a row came from and what changed it, in words; `side` names the account where a transfer has two
  const history = (r, side = null) => h('details', { className: 'dm-disclosure' }, h('summary', {}, side ? `Source · ${side}` : 'Source and history'),
    h('ul', { className: 'dm-history' },
      ...(r.sources.length ? r.sources.map((s) => h('li', { key: s.raw }, `${sourceText(s.source)}${s.role === 'matched' ? ', matched to an earlier row' : s.role === 'pending_of' ? ', the pending row it replaced' : ''}`))
        : [h('li', {}, 'Entered here')]),
      r.parent_id ? h('li', {}, 'A line of a split transaction') : null,
      r.merged_into ? h('li', {}, 'Merged into another transaction') : null,
      r.merged.length ? h('li', {}, `Holds ${plural(r.merged.length, 'merged transaction')}`) : null,
      ...r.edits.map((e, i) => h('li', { key: `e${i}` }, `${dateTimeText(e.at, { now: new Date() }) || e.at} · ${editText(e, categories)}`))));
  const tags = (r) => r.tags.filter((x) => !INTERNAL.has(x));
  const details = (r) => h('dl', {}, field('Amount', money(r.amount_cents)), field('Payee', r.description || '(no payee)'),
    field('Date', day(r.date)), field('Account', r.account.name),
    field('Category', r.split_lines?.length ? `Split · ${plural(r.split_lines.length, 'line')}` : categoryText(r.category?.name)),
    r.split_lines?.length ? null : field('Category from', sentence(r.why?.text ?? 'not set yet')), field('Notes', r.notes || 'No notes'),
    tags(r).length ? field('Tags', tags(r).join(', ')) : null, r.pending ? field('Posting', 'Pending') : null);
  // the other side and the lines: what tells them apart, not every field again
  const brief = (r) => h('dl', {}, field('Account', r.account.name), field('Amount', money(r.amount_cents)), field('Date', day(r.date)));
  const line = (r) => h('dl', {}, field(categoryText(r.category?.name), money(r.amount_cents)));
  return h('div', {}, details(t),
    t.counterparts.length ? h('section', {}, h('h3', {}, 'Other side'),
      ...t.counterparts.map((r) => h('div', { key: r.id }, brief(r), history(r, r.account.name))))
      : t.tags.includes('external') ? h('p', {}, 'The other side is an outside account.') : null,
    t.split_lines.length ? h('section', {}, h('h3', {}, 'Split lines'), ...t.split_lines.map((r) => h('div', { key: r.id }, line(r)))) : null,
    history(t, t.counterparts.length ? t.account.name : null));
}

// The selected merge target survives; choices come from the current filtered list.
export function transactionActions(h, t, { money, day, saving, into, confirmDelete, candidates, onInto, onConfirmDelete, change }) {
  return h('section', { 'aria-label': 'Owner actions', className: 'dm-txn-actions' },
    h('label', { className: 'dm-check' }, h('input', { type: 'checkbox', checked: t.tags.includes('excluded'), disabled: saving,
      onChange: (ev) => change('excluded', { excluded: ev.currentTarget.checked }) }), 'Not in reports'),
    h('form', { onSubmit: (ev) => { ev.preventDefault(); if (!saving && into) return change('merge', { into: Number(into) }); } },
      h('label', {}, 'Merge into (keep this transaction)', h('select', { className: 'pick', value: into, disabled: saving,
        onChange: (ev) => onInto(ev.currentTarget.value) },
      h('option', { value: '' }, 'Choose from the current list'),
      ...candidates.map((r) => h('option', { key: r.id, value: String(r.id) },
        `${day(r.date)} · ${r.description || '(no payee)'} · ${r.account.name} · ${money(r.amount_cents)}`)))),
      h('p', {}, 'This transaction will be merged into the selected transaction. Its sources will move to the survivor.'),
      h('button', { type: 'submit', className: 'btn', disabled: saving || !into }, 'Merge')),
    confirmDelete ? h('div', { className: 'dm-confirm', role: 'group', 'aria-label': 'Confirm delete' }, h('p', {}, 'Delete this transaction? Its history will be kept.'),
      h('div', { className: 'acts' },
        h('button', { type: 'button', className: 'btn', 'data-variant': 'danger', disabled: saving, onClick: () => change('status', { status: 'deleted' }) }, 'Confirm delete'),
        h('button', { type: 'button', className: 'btn', disabled: saving, onClick: () => onConfirmDelete(false) }, 'Cancel')))
      : h('div', { className: 'acts' }, h('button', { type: 'button', className: 'btn', 'data-variant': 'danger', disabled: saving, onClick: () => onConfirmDelete(true) }, 'Delete')));
}
