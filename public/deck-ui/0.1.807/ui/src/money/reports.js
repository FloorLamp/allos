import {dateRange} from '../format.js';
import {delta} from '../quantity.js';
import {categoryText, spentQuantity, spentText} from './labels.js';
// Spending by category (`/spending`): the last 12 months' net spending, the chart of its months by category and the table by category.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, deckUi, el, location } = ctx;
const [{ mountStatTiles }, { Chart }, { h, render }] = await Promise.all([
  mountMoneyPage(), deckUi('ui/src/view/chart.js'), deckUi('ui/vendor/preact.mjs'),
]);
const tiles = mountStatTiles($('stats'));
let r;
try { r = await api('/api/spending?group=category&grain=month'); } catch (e) { return ctx.fail(e); }
if (!r.items.length) return ctx.empty({ title: 'No spending yet', line: 'Spending in the last 12 months shows here by category.', glyph: 'receipt' });
$('period').textContent = `${dateRange(r.from, r.to, { now: new Date() })} · Last 12 months`;
const current = r.months.at(-1), last = r.months.at(-2), groups = new Map();
for (const x of r.items) {
  if (!groups.has(x.id)) groups.set(x.id, { id: x.id, name: x.name, months: new Map(), total: 0 });
  const g = groups.get(x.id);
  g.months.set(x.month, x.spending_cents); g.total += x.spending_cents;
}
const categories = [...groups.values()].sort((a, b) => b.total - a.total);
const link = (g, from = r.from, to = r.to) => `/transactions?${new URLSearchParams({ category: g.id ?? 'none', from, to })}`;
const total = (month) => r.items.filter((x) => !month || x.month === month).reduce((s, x) => s + x.spending_cents, 0);
tiles.update({ tiles: [
  { key: 'total', label: 'Last 12 months', quantity: spentQuantity(total()) },
  { key: 'current', label: 'This month', quantity: spentQuantity(total(current)), sub: 'Month to date' },
  { key: 'last', label: 'Last month', quantity: spentQuantity(total(last)) },
  { key: 'average', label: 'Monthly average', quantity: spentQuantity(total() / 12) },
] });
const chartGroups = categories.slice(0, 10);
if (categories.length > 10) {
  const months = new Map();
  for (const g of categories.slice(10)) for (const [month, cents] of g.months) months.set(month, (months.get(month) ?? 0) + cents);
  chartGroups.push({ name: `${categories.length - 10} more categories`, months });
}
const parts = chartGroups.map((g) => ({ name: categoryText(g.name) }));
// spending is money out: a category's month with more refunded than spent draws no bar (the table keeps its refund)
const points = chartGroups.flatMap((g, part) => r.months.map((period) => ({ period, part,
  value: Math.max(0, g.months.get(period) ?? 0) / 100, ref: g.id === undefined ? null : link(g, `${period}-01`, period === current ? r.to : new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7), 0)).toISOString().slice(0, 10)), label: categoryText(g.name) })));
render(h(Chart, { data: { title: 'Monthly spending', unit: 'USD', valueName: 'Spending', parts, points }, onOpen: (href) => location.assign(href) }), $('chart'));
$('categories').replaceChildren(...categories.map((g) => {
  const thisMonth = g.months.get(current) ?? 0, lastMonth = g.months.get(last) ?? 0;
  // more spent than last month reads as bad, less as good: a change is never colour alone (its sign says it)
  const change = lastMonth > 0 ? delta({ value: thisMonth, format: 'currency' }, { value: lastMonth }, { higher: 'bad' }) : null;
  return el('tr', {}, el('th', { scope: 'row' }, el('a', { href: link(g), textContent: categoryText(g.name) })),
    ...[thisMonth, lastMonth, g.total / 12].map((cents) => el('td', { className: cents < 0 ? 'tone-good' : '', textContent: spentText(cents) })),
    el('td', { className: change ? `tone-${change.tone}` : '', textContent: change?.pct ?? '–' }));
}));

}
