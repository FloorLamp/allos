import {countText, dateRange, plural} from '../format.js';
import { ruleTitle } from './rule-title.js';
import {moneyFailure} from './failure.js';
import {amountQuantity, categoryText, spentQuantity} from './labels.js';
import {transactionRow} from './transaction.js';
import {PAGE_SIZE} from '../view/collection-page.js';
// Faithful port of Purser merchant.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, el, deckUi, money, day, post, session: getSession, fixBar, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
// A merchant (`/spending/merchant?id=`): its default category and why (your rule, a rule you accepted, learned from history or from your
// corrections), its rules, how its rows are categorised now, and its rows. The owner sets the category for all its rows (or all
// and future: a rule) or for picked ones (fix.js): the fastest way to fix a default Simplifi's history got wrong.

const { mountRows, mountStatTiles, host } = await mountMoneyPage();
const id = Number(new URLSearchParams(location.search).get('id'));
const PAGE = PAGE_SIZE;
const path = categoryText;
const SOURCE = { user: 'you', simplifi: 'Simplifi', rule: 'rules', plaid: 'Plaid', llm: 'the model' };
const list = mountRows($('rows'), host, { loading: 8, search: false });
let items = [], total = 0, m = null, bar = null;
const picked = new Set();

const row = (t) => transactionRow(t, { href: `/transactions?merchant=${id}&kind=all&txn=${t.id}` });
const draw = () => list.update({ loading: 0, error: null, items: items.map(row), checked: [...picked].map(String), empty: { title: 'No transactions', glyph: 'receipt' } });

function facts() {
  const d = m.default;
  $('name').textContent = m.name;
  document.title = `${m.name} · Money`;
  $('facts').replaceChildren(
    el('div', {}, el('b', { textContent: 'Default: ' }), `${d.category ? path(d.category.name) : 'none'} · ${d.why}`),
    el('div', { className: 'meta', textContent: `Now: ${m.categories.map((c) => `${path(c.category?.name)} ${countText(c.rows)} (${SOURCE[c.source] ?? 'nothing'})`).join(' · ')}` }),
    ...(m.rules.length ? [el('div', { className: 'meta', textContent: `Rules: ${m.rules.map((r) => `${ruleTitle(r.conditions ?? r.text, path(r.category?.name), { merchants: [m] })} (${plural(r.hits, 'row')})`).join(' · ')}` })] : []));
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
    $('summary').textContent = `${plural(total, 'transaction')}, all time`;
    draw();
    bar?.refresh();
    $('more').hidden = items.length >= total;
  } catch (e) {
    if (!more) return ctx.fail(e);
    list.update({ loading: 0, error: { title: 'Could not load the merchant', line: moneyFailure(e, 'load merchant details'), action: 'Retry', onAction: () => load() } });
  }
}

$('more').addEventListener('click', () => load({ more: true }));
let session, categories, merchants;
try { [session, { categories, merchants }] = await Promise.all([getSession(), api('/api/facets')]); } catch (e) { return ctx.fail(e); }
if (session.owner) list.update({ checkable: true, onCheck: (i, on) => { if (on) picked.add(Number(i)); else picked.delete(Number(i)); draw(); bar.refresh(); } });
await load();
bar = fixBar($('fix'), { session, categories, target, onDone: () => load() });

// A merchant's last 12 months, as Reports reads them: spending (money out, refunds netted) and money received from it (income rows:
// a payroll's page reads Received), each in the same tiles; a merchant with both shows both.
async function spendingHeader() {
  try {
    const [r, { Chart }, { h, render }] = await Promise.all([
      api('/api/spending?group=merchant&grain=month'),
      deckUi('ui/src/view/chart.js'), deckUi('ui/vendor/preact.mjs'),
    ]);
    const income = await api(`/api/txns?${new URLSearchParams({ merchant: id, kind: 'income', from: r.from, to: r.to, limit: 1 })}`);
    const rows = r.items.filter((x) => x.id === id);
    const byMonth = new Map(rows.map((x) => [x.month, x.spending_cents]));
    const total = rows.reduce((n, x) => n + x.spending_cents, 0);
    const received = income.total ? income.flow_cents ?? income.sum_cents : 0, last = income.items[0];
    if (!rows.length && !received) { $('period').textContent = 'No spending or income in the last 12 months.'; return; }
    $('period').textContent = [dateRange(r.from, r.to, { now: new Date() }), 'Last 12 months', rows.length ? 'Refunds net against spending' : null].filter(Boolean).join(' · ');
    if (rows.length) {
      mountStatTiles($('stats'), { label: 'Spending', tiles: [
        { key: 'total', label: 'Spent, last 12 months', quantity: spentQuantity(total) },
        { key: 'current', label: 'Spent this month', quantity: spentQuantity(byMonth.get(r.months.at(-1)) ?? 0) },
        { key: 'average', label: 'Monthly average', quantity: spentQuantity(total / 12) },
      ] });
      render(h(Chart, { data: { title: 'Monthly spending', unit: 'USD', valueName: 'Spending',
        points: r.months.map((period) => ({ period, value: Math.max(0, byMonth.get(period) ?? 0) / 100 })) } }), $('chart'));
    }
    if (received) mountStatTiles($('received'), { label: 'Received', tiles: [
      { key: 'received', label: 'Received, last 12 months', quantity: amountQuantity(received) },
      { key: 'received-average', label: 'Monthly average', quantity: amountQuantity(received / 12) },
      { key: 'last-payment', label: 'Last payment', quantity: amountQuantity(last?.amount_cents ?? 0), sub: last ? day(last.date) : null },
    ] });
  } catch (e) { $('period').textContent = moneyFailure(e, 'load merchant details'); }
}
await spendingHeader();

if (session.owner) {
  const select = el('select', { className: 'pick', 'ariaLabel': 'Surviving merchant' }, el('option', { value: '', textContent: 'Choose a merchant…' }),
    ...merchants.filter((m) => m.id !== id).map((m) => el('option', { value: m.id, textContent: m.name })));
  const status = el('p', { role: 'status', className: 'meta' });
  const confirm = el('button', { className: 'btn primary', textContent: 'Confirm merge', hidden: true });
  let preview = null;
  const button = el('button', { className: 'btn', textContent: 'Preview merge', disabled: true });
  select.addEventListener('change', () => { preview = null; confirm.hidden = true; status.textContent = ''; button.disabled = !select.value; });
  button.onclick = async () => {
    confirm.hidden = true;
    try {
      const request = { id, into: Number(select.value) };
      const result = await post('/api/merchant-merge', { ...request, preview: true });
      preview = { ...request, token: result.token };
      status.textContent = `${plural(result.rows, 'affected transaction')}. ${result.survivor.name} survives with ${plural(result.total, 'transaction')}. Future matching imports use this merchant. Its default category is kept.`;
      confirm.hidden = false;
    } catch (e) { status.textContent = moneyFailure(e, 'merge merchants'); }
  };
  confirm.onclick = async () => {
    confirm.disabled = true;
    try { const result = await post('/api/merchant-merge', preview); location.assign(`/spending/merchant?id=${result.survivor.id}`); }
    catch (e) { status.textContent = moneyFailure(e, 'merge merchants'); confirm.hidden = true; }
    finally { confirm.disabled = false; }
  };
  $('merge').hidden = false;
  $('merge').append(el('h2', { textContent: 'Merge into another merchant' }), select, el('div', { className: 'acts' }, button, confirm), status);
}

}
