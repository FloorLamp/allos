import { ruleTitle } from './rule-title.js';
import {moneyFailure} from './failure.js';
// Faithful port of Purser merchant.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, el, deckUi, money, post, session: getSession, fixBar, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
// A merchant (`/merchant?id=`): its default category and why (your rule, a rule you accepted, learned from history or from your
// corrections), its rules, how its rows are categorised now, and its rows. The owner sets the category for all its rows (or all
// and future: a rule) or for picked ones (fix.js): the fastest way to fix a default Simplifi's history got wrong.

const { mountRows, mountStatTiles, money: moneyQuantity, dateSection, host } = await mountMoneyPage();
const id = Number(new URLSearchParams(location.search).get('id'));
const PAGE = 100;
const path = (name) => (name ?? 'Uncategorized').replaceAll(':', ' › ');
const SOURCE = { user: 'you', simplifi: 'Simplifi', rule: 'rules', plaid: 'Plaid', llm: 'the model' };
const list = mountRows($('rows'), host, { loading: 8 });
let items = [], total = 0, m = null, bar = null;
const picked = new Set();

const row = (t) => ({
  id: String(t.id), glyph: null, section: dateSection(t.date), title: t.description || '(no payee)',
  sub: [t.lines ? `Split · ${t.lines} lines` : path(t.category?.name), t.account.name].join(' · '),
  notes: t.why?.by && t.why.by !== 'simplifi' ? [{ text: `${t.why.text}${t.category_source === 'rule' && t.confidence < 0.8 ? ', unsure' : ''}`, tone: t.category_source === 'rule' && t.confidence < 0.8 ? 'warn' : '' }] : [],
  quantity: moneyQuantity(t.amount_cents / 100),
});
const draw = () => list.update({ loading: 0, error: null, items: items.map(row), checked: [...picked].map(String), empty: { title: 'No transactions', glyph: 'receipt' } });

function facts() {
  const d = m.default;
  $('name').textContent = m.name;
  document.title = `${m.name} · Money`;
  $('facts').replaceChildren(
    el('div', {}, el('b', { textContent: 'Default: ' }), `${d.category ? path(d.category.name) : 'none'} · ${d.why}`),
    el('div', { className: 'meta', textContent: `Now: ${m.categories.map((c) => `${path(c.category?.name)} ${c.rows.toLocaleString()} (${SOURCE[c.source] ?? 'nothing'})`).join(' · ')}` }),
    ...(m.rules.length ? [el('div', { className: 'meta', textContent: `Rules: ${m.rules.map((r) => `${ruleTitle(r.conditions ?? r.text, path(r.category?.name), { merchants: [m] })} (${r.hits.toLocaleString()} rows)`).join(' · ')}` })] : []));
}

function target() {
  if (picked.size) {
    const n = picked.size;
    return { spec: { txns: [...picked] }, label: `${n} picked`, scopes: [['this', n === 1 ? 'This one' : `These ${n}`], ['merchant', 'All its rows'], ['future', 'This and future']] };
  }
  return { spec: { merchant: id }, label: `Set category for ${m?.name ?? 'this merchant'}`, scopes: [['merchant', 'All its rows'], ['future', 'All and future']] };
}

async function load({ more = false } = {}) {
  try {
    const [v, r] = await Promise.all([more ? m : api(`/api/merchant/${id}`), api(`/api/txns?merchant=${id}&limit=${PAGE}&offset=${more ? items.length : 0}`)]);
    m = v;
    items = more ? [...items, ...r.items] : r.items;
    total = r.total;
    if (!more) picked.clear();
    facts();
    $('summary').textContent = `${total.toLocaleString()} ${total === 1 ? 'transaction' : 'transactions'} · net ${money(r.sum_cents)}`;
    draw();
    bar?.refresh();
    $('more').hidden = items.length >= total;
  } catch (e) {
    list.update({ loading: 0, error: { title: 'Could not load the merchant', line: moneyFailure(e, 'load merchant details'), action: 'Retry', onAction: () => load() } });
  }
}

$('more').addEventListener('click', () => load({ more: true }));
const [session, { categories }] = await Promise.all([getSession(), api('/api/facets')]);
if (session.owner) list.update({ checkable: true, onCheck: (i, on) => { if (on) picked.add(Number(i)); else picked.delete(Number(i)); draw(); bar.refresh(); } });
await load();
bar = fixBar($('fix'), { session, categories, target, onDone: () => load() });

// Merchant reports share the same net-spending query and calendar as Reports.
async function spendingHeader() {
  try {
    const [r, { Chart }, { h, render }] = await Promise.all([
      api('/api/spending?group=merchant&grain=month'),
      deckUi('ui/src/view/chart.js'), deckUi('ui/vendor/preact.mjs'),
    ]);
    const rows = r.items.filter((x) => x.id === id);
    const byMonth = new Map(rows.map((x) => [x.month, x.spending_cents]));
    const total = rows.reduce((n, x) => n + x.spending_cents, 0);
    const value = (n) => money(n, { sign: false });
    $('period').textContent = `${r.from} – ${r.to} · Refunds net against spending`;
    mountStatTiles($('stats'), { tiles: [
      { key: 'total', label: 'Last 12 months', value: value(total) },
      { key: 'current', label: 'This month', value: value(byMonth.get(r.months.at(-1)) ?? 0) },
      { key: 'average', label: 'A month', value: value(total / 12), sub: '12-month average' },
    ] });
    render(h(Chart, { data: { title: 'Monthly spending', unit: 'USD', valueName: 'Net spending',
      points: r.months.map((period) => ({ period, value: (byMonth.get(period) ?? 0) / 100 })) } }), $('chart'));
  } catch (e) { $('period').textContent = moneyFailure(e, 'load merchant details'); }
}
await spendingHeader();

if (session.owner) {
  const { merchants } = await api('/api/facets');
  const select = el('select', { 'ariaLabel': 'Surviving merchant' },
    ...merchants.filter((m) => m.id !== id).map((m) => el('option', { value: m.id, textContent: m.name })));
  const status = el('p', { role: 'status' });
  const confirm = el('button', { className: 'btn', textContent: 'Confirm merge', hidden: true });
  let preview = null;
  select.addEventListener('change', () => { preview = null; confirm.hidden = true; status.textContent = ''; });
  const button = el('button', { className: 'btn', textContent: 'Preview merge' });
  button.onclick = async () => {
    confirm.hidden = true;
    try {
      const request = { id, into: Number(select.value) };
      const result = await post('/api/merchant-merge', { ...request, preview: true });
      preview = { ...request, token: result.token };
      status.textContent = `${result.rows} affected transactions. ${result.survivor.name} survives with ${result.total} transactions. Future matching imports use this merchant. Its default category is kept.`;
      confirm.hidden = false;
    } catch (e) { status.textContent = moneyFailure(e, 'merge merchants'); }
  };
  confirm.onclick = async () => {
    confirm.disabled = true;
    try { const result = await post('/api/merchant-merge', preview); location.assign(`/merchant?id=${result.survivor.id}`); }
    catch (e) { status.textContent = moneyFailure(e, 'merge merchants'); confirm.hidden = true; }
    finally { confirm.disabled = false; }
  };
  $('merge').hidden = false;
  $('merge').append(el('h2', { textContent: 'Merge into another merchant' }), select, button, status, confirm);
}

}
