import { ruleTitle } from './rule-title.js';
import {moneyFailure} from './failure.js';
// Faithful port of Purser classification.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, post, el, session, deckUi, signIn, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const [{ mountRows, mountStatTiles, mountDrawer, money, dateSection, host }, { h }, { RowList }] = await Promise.all([
  mountMoneyPage(), deckUi('ui/vendor/preact.mjs'), deckUi('ui/src/view/rows.js')]);
const type = location.pathname.split(/\//).at(-1), endpoint = `/api/${type}`, owner = (await session()).owner;
$('title').textContent = type === 'rules' ? 'Rules' : 'Categories';
const list = mountRows($('rows'), host, {}), stats = mountStatTiles($('stats'));
const drawer = mountDrawer($('drawer'), { onClose: () => drawer.update({ open: false }) });
let state;
const fail = (e) => { $('summary').textContent = moneyFailure(e, 'update rules and categories'); };
const button = (text, fn) => el('button', { className: 'btn', type: 'button', textContent: text, onclick: () => Promise.resolve().then(fn).catch(fail) });
const field = (label, value = '') => el('label', { textContent: `${label} ` }, el('input', { className: 'field', ariaLabel: label, value }));
const select = (label, choices, value) => el('label', { textContent: `${label} ` }, el('select', { className: 'pick', ariaLabel: label }, ...choices.map(([id, text]) => el('option', { value: id, textContent: text, selected: String(id) === String(value) }))));
const value = (e) => e.querySelector('input,select').value;
const category = (label, id, root = false) => select(label, [...(root ? [['', 'Top level']] : []), ...state.categories.map((c) => [c.id, c.path])], id ?? '');
async function preview(body) {
  const p = await post(endpoint, { ...body, preview: true });
  drawer.update({ open: true, title: 'Preview change', sub: `${body.action}${body.name ? `: ${body.name}` : ''} · ${p.rows} transactions affected`, children: h('div', {},
    h('p', {}, body.action === 'batch' ? `${body.changes.length} selected merges` : body.action === 'move' ? `Parent → ${state.categories.find((c) => c.id === body.parent_id)?.path ?? 'Top level'}` : body.action === 'merge' ? `Merge → ${state.categories.find((c) => c.id === body.target)?.path}` : body.action === 'save' ? `Category → ${state.categories.find((c) => c.id === body.category_id)?.path}` : body.name ?? body.action),
    h(RowList, { items: p.changes.map((c) => ({ id: String(c.id), glyph: null, title: c.description || `Transaction ${c.id}`, sub: `${state.categories.find((x) => x.id === c.from)?.path ?? 'Uncategorized'} → ${state.categories.find((x) => x.id === c.to)?.path ?? 'Uncategorized'}`, quantity: money(c.amount_cents / 100), section: dateSection(c.date) })) }),
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
  const kind = select('Kind', ['expense', 'income', 'transfer'].map((x) => [x, x]), c.kind ?? 'expense');
  $('editor').replaceChildren(name, parent, ...(c.id ? [
    button('Preview rename', () => preview({ action: 'rename', id: c.id, name: value(name) })),
    button('Preview move', () => preview({ action: 'move', id: c.id, parent_id: Number(value(parent)) || null })), target,
    button('Preview merge', () => preview({ action: 'merge', id: c.id, target: Number(value(target)) }))] : [kind,
    button('Preview create', () => preview({ action: 'create', name: value(name), parent_id: Number(value(parent)) || null, kind: value(kind) }))]));
}
async function load() {
  state = await api(endpoint);
  const facets = type === 'rules' ? await api('/api/facets') : {};
  stats.update({ tiles: [{ key: 'rules', label: 'Rules', value: String(state.rules.length) }, { key: 'categories', label: 'Categories', value: String(state.categories.length) }] });
  const rules = type === 'rules';
  list.update({ items: rules ? state.rules.map((r) => ({ id: String(r.id), glyph: null, title: ruleTitle(r.conditions, state.categories.find((c) => c.id === r.actions.category_id)?.path, facets), end: owner ? { label: 'Edit', onClick: () => editRule(r) } : null,
    sub: `${state.categories.find((c) => c.id === r.actions.category_id)?.path ?? 'Uncategorized'} · ${r.hits} hits · ${r.source === 'user' ? 'owner' : r.conditions.seed ? 'built-in' : 'learned'} · ${r.enabled ? 'enabled' : 'disabled'}` })) :
    state.categories.map((c) => ({ id: String(c.id), glyph: null, title: c.path, end: owner ? { label: 'Edit', onClick: () => editCategory(c) } : null, sub: `${c.kind} · ${c.n} transactions` })),
    onOpen: owner ? (r) => rules ? editRule(state.rules.find((x) => String(x.id) === r.id)) : editCategory(state.categories.find((x) => String(x.id) === r.id)) : undefined });
  if (!owner) { $('actions').replaceChildren(el('a', { href: signIn(), textContent: 'Sign in as owner to edit' })); return; }
  $('actions').replaceChildren(button(rules ? 'Create rule' : 'Create category', () => rules ? editRule() : editCategory()));
  if (!rules && state.suggestions.length) {
    const picks = state.suggestions.map((s) => ({ ...s, checked: el('input', { type: 'checkbox', checked: true }), target: category('Merge into', s.target) }));
    $('actions').append(el('div', {}, el('p', { textContent: 'Proposed small or overlapping categories — edit or uncheck before previewing.' }),
      ...picks.map((p) => el('div', {}, p.checked, state.categories.find((c) => c.id === p.id).path, p.target)),
      button('Preview selected merges', () => preview({ action: 'batch', changes: picks.filter((p) => p.checked.checked).map((p) => ({ action: 'merge', id: p.id, target: Number(value(p.target)) })) }))));
  }
}
try { await load(); const filter = new URLSearchParams(location.search).get('filter'); if (filter && owner) editRule({ conditions: { filter: JSON.parse(filter) } }); } catch (e) { fail(e); }

}
