import { ruleTitle } from './rule-title.js';
import {fieldLabel, plural} from '../format.js';
import {moneyFailure} from './failure.js';
import {categoryText, kindText, ownerNotice} from './labels.js';
// Faithful port of Purser classification.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, post, el, session, deckUi, signIn, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const [{ mountRows, mountStatTiles, mountDrawer, money, dateSection, host }, { h }, { RowList }] = await Promise.all([
  mountMoneyPage(), deckUi('ui/vendor/preact.mjs'), deckUi('ui/src/view/rows.js')]);
const type = location.pathname.split(/\//).at(-1), endpoint = `/api/${type}`;
const who = await session().catch(() => ({ owner: false })), owner = who.owner;
$('title').textContent = type === 'rules' ? 'Rules' : 'Categories';
const list = mountRows($('rows'), host, { search: false }), stats = mountStatTiles($('stats'));
const drawer = mountDrawer($('drawer'), { onClose: () => drawer.update({ open: false }) });
let state;
const fail = (e) => { $('summary').textContent = moneyFailure(e, 'update rules and categories'); };
const button = (text, fn) => el('button', { className: 'btn', type: 'button', textContent: text, onclick: () => Promise.resolve().then(fn).catch(fail) });
const field = (label, value = '') => el('label', { textContent: `${label} ` }, el('input', { className: 'field', ariaLabel: label, value }));
const select = (label, choices, value) => el('label', { textContent: `${label} ` }, el('select', { className: 'pick', ariaLabel: label }, ...choices.map(([id, text]) => el('option', { value: id, textContent: text, selected: String(id) === String(value) }))));
const value = (e) => e.querySelector('input,select').value;
const category = (label, id, root = false) => select(label, [...(root ? [['', 'Top level']] : []), ...state.categories.map((c) => [c.id, categoryText(c.path)])], id ?? '');
const pathOf = (id) => categoryText(state.categories.find((c) => c.id === id)?.path ?? null);
async function preview(body) {
  const p = await post(endpoint, { ...body, preview: true });
  drawer.update({ open: true, title: 'Preview change', sub: `${fieldLabel(body.action)}${body.name ? `: ${body.name}` : ''} · ${plural(p.rows, 'transaction')} affected`, children: h('div', {},
    h('p', {}, body.action === 'batch' ? `${body.changes.length} selected merges` : body.action === 'move' ? `Parent → ${body.parent_id ? pathOf(body.parent_id) : 'Top level'}` : body.action === 'merge' ? `Merge → ${pathOf(body.target)}` : body.action === 'save' ? `Category → ${pathOf(body.category_id)}` : body.name ?? body.action),
    h(RowList, { items: p.changes.map((c) => ({ id: String(c.id), glyph: null, title: c.description || `Transaction ${c.id}`, sub: `${pathOf(c.from)} → ${pathOf(c.to)}`, quantity: money(c.amount_cents / 100), section: dateSection(c.date) })) }),
    h('button', { className: 'btn primary', onClick: async () => {
      try { const result = await post(endpoint, { ...body, token: p.token }); drawer.update({ open: false }); await load(); $('summary').textContent = `Batch ${result.batch}: ${result.rows} rows applied.`; }
      catch (e) { fail(e); drawer.update({ open: false }); }
    } }, 'Apply batch')) });

}
function editRule(r = {}) {
  const conditions = field('Conditions (JSON)', JSON.stringify(r.conditions ?? {}));
  const cat = category('Category', r.actions?.category_id);
  $('editor').replaceChildren(el('p', { className: 'meta', textContent: 'Conditions: description, merchant_id, account_id, sign (in/out), min_cents, max_cents; all conditions must match. Owner-set rows are kept.' }), conditions, cat, button('Preview rule', () => preview({ action: 'save', id: r.id, conditions: JSON.parse(value(conditions)), category_id: Number(value(cat)) })),
    ...(r.id ? [button('Disable', () => preview({ action: 'disable', id: r.id })), button('Delete', () => preview({ action: 'delete', id: r.id }))] : []));
}
function editCategory(c = {}) {
  const name = field('Name', c.name ?? ''), parent = category('Parent', c.parent_id, true), target = category('Merge into', c.id);
  const kind = select('Kind', ['expense', 'income', 'transfer'].map((x) => [x, kindText(x)]), c.kind ?? 'expense');
  $('editor').replaceChildren(name, parent, ...(c.id ? [
    button('Preview rename', () => preview({ action: 'rename', id: c.id, name: value(name) })),
    button('Preview move', () => preview({ action: 'move', id: c.id, parent_id: Number(value(parent)) || null })), target,
    button('Preview merge', () => preview({ action: 'merge', id: c.id, target: Number(value(target)) }))] : [kind,
    button('Preview create', () => preview({ action: 'create', name: value(name), parent_id: Number(value(parent)) || null, kind: value(kind) }))]));
}
async function load() {
  state = await api(endpoint);
  const facets = type === 'rules' ? await api('/api/facets') : {};
  const rules = type === 'rules';
  // the tiles count this page's own list
  stats.update({ tiles: rules ? [{ key: 'rules', label: 'Rules', value: String(state.rules.length) }, { key: 'enabled', label: 'Enabled', value: String(state.rules.filter((r) => r.enabled).length) }]
    : ['expense', 'income', 'transfer'].map((k) => ({ key: k, label: { expense: 'Spending', income: 'Income', transfer: 'Transfers' }[k], value: String(state.categories.filter((c) => c.kind === k).length) })) });
  // categories by kind, each parent followed by its children (their paths sort that way)
  const order = { expense: 0, income: 1, transfer: 2 };
  const categories = [...state.categories].sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || a.path.localeCompare(b.path));
  const KINDS = { expense: 'Spending', income: 'Income', transfer: 'Transfers' };
  list.update({ items: rules ? state.rules.map((r) => ({ id: String(r.id), glyph: null, title: ruleTitle(r.conditions, state.categories.find((c) => c.id === r.actions.category_id)?.path, facets), end: owner ? { label: 'Edit', onClick: () => editRule(r) } : null,
    sub: `${pathOf(r.actions.category_id)} · ${plural(r.hits, 'hit')} · ${r.source === 'user' ? 'Yours' : r.conditions.seed ? 'Built in' : 'Learned'}${r.enabled ? '' : ' · Disabled'}` })) :
    categories.map((c) => ({ id: String(c.id), glyph: null, title: categoryText(c.path), section: { key: c.kind, label: KINDS[c.kind] ?? kindText(c.kind) },
      end: owner ? { label: 'Edit', onClick: () => editCategory(c) } : null, sub: plural(c.n, 'transaction') })),
    empty: rules ? { title: 'No rules yet', line: 'Each merchant’s default category applies until a rule says otherwise. Create one, or make one from a search on Transactions.' }
      : { title: 'No categories yet', line: 'Import a Simplifi export, or create one.' },
    onOpen: owner ? (r) => rules ? editRule(state.rules.find((x) => String(x.id) === r.id)) : editCategory(state.categories.find((x) => String(x.id) === r.id)) : undefined });
  if (!owner) { $('actions').replaceChildren(ownerNotice(ctx, who, `Sign in as the owner to edit ${rules ? 'rules' : 'categories'}.`)); return; }
  $('actions').replaceChildren(button(rules ? 'Create rule' : 'Create category', () => rules ? editRule() : editCategory()));
  if (!rules && state.suggestions.length) {
    const picks = state.suggestions.map((s) => ({ ...s, checked: el('input', { type: 'checkbox', checked: true }), target: category('Merge into', s.target) }));
    $('actions').append(el('div', {}, el('p', { textContent: 'Proposed small or overlapping categories — edit or uncheck before previewing.' }),
      ...picks.map((p) => el('div', { className: 'acts' }, el('label', { className: 'dm-check' }, p.checked, categoryText(state.categories.find((c) => c.id === p.id).path)), p.target)),
      button('Preview selected merges', () => preview({ action: 'batch', changes: picks.filter((p) => p.checked.checked).map((p) => ({ action: 'merge', id: p.id, target: Number(value(p.target)) })) }))));
  }
}
try { await load(); } catch (e) { return ctx.fail(e); }
try { const filter = new URLSearchParams(location.search).get('filter'); if (filter && owner) editRule({ conditions: { filter: JSON.parse(filter) } }); } catch (e) { fail(e); }

}
