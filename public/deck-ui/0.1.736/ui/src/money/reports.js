import {moneyFailure} from './failure.js';
// Faithful port of Purser reports.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, deckUi, el, money, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const [{ mountStatTiles }, { Chart }, { h, render }] = await Promise.all([
  mountMoneyPage(), deckUi('ui/src/view/chart.js'), deckUi('ui/vendor/preact.mjs'),
]);
const tiles = mountStatTiles($('stats'));
const value = (cents) => money(cents, { sign: false });
try {
  const r = await api('/api/spending?group=category&grain=month');
  $('period').textContent = `${r.from} – ${r.to} · ${r.timeZone} · Last 12 months`;
  const current = r.months.at(-1), last = r.months.at(-2), groups = new Map();
  for (const x of r.items) {
    if (!groups.has(x.id)) groups.set(x.id, { id: x.id, name: x.name, months: new Map(), total: 0 });
    const g = groups.get(x.id);
    g.months.set(x.month, x.spending_cents); g.total += x.spending_cents;
  }
  const categories = [...groups.values()].sort((a, b) => b.total - a.total);
  const link = (g, from = r.from, to = r.to) => `/?${new URLSearchParams({ category: g.id ?? 'none', from, to })}`;
  const total = (month) => r.items.filter((x) => !month || x.month === month).reduce((s, x) => s + x.spending_cents, 0);
  tiles.update({ tiles: [
    { key: 'total', label: 'Last 12 months', value: value(total()) },
    { key: 'current', label: 'This month', value: value(total(current)), sub: 'Month to date' },
    { key: 'last', label: 'Last month', value: value(total(last)) },
    { key: 'average', label: 'A month', value: value(total() / 12), sub: '12-month average' },
  ] });
  const chartGroups = categories.slice(0, 10);
  if (categories.length > 10) {
    const months = new Map();
    for (const g of categories.slice(10)) for (const [month, cents] of g.months) months.set(month, (months.get(month) ?? 0) + cents);
    chartGroups.push({ name: 'Other', months });
  }
  const parts = chartGroups.map((g) => ({ name: g.name.replaceAll(':', ' › ') }));
  const points = chartGroups.flatMap((g, part) => r.months.map((period) => ({ period, part,
    value: (g.months.get(period) ?? 0) / 100, ref: g.id === undefined ? null : link(g, `${period}-01`, period === current ? r.to : new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7), 0)).toISOString().slice(0, 10)), label: g.name })));
  // Keep an empty ledger's calendar visible too.
  render(h(Chart, { data: { title: 'Monthly spending', unit: 'USD', valueName: 'Net spending', parts,
    points: points.length ? points : r.months.map((period) => ({ period, value: 0 })) }, onOpen: (href) => location.assign(href) }), $('chart'));
  $('categories').replaceChildren(...categories.map((g) => {
    const thisMonth = g.months.get(current) ?? 0, lastMonth = g.months.get(last) ?? 0;
    const change = lastMonth ? `${((thisMonth - lastMonth) / Math.abs(lastMonth) * 100).toFixed(1)}%` : '–';
    return el('tr', {}, el('th', { scope: 'row' }, el('a', { href: link(g), textContent: g.name.replaceAll(':', ' › ') })),
      ...[value(thisMonth), value(lastMonth), value(g.total / 12), change].map((textContent) => el('td', { textContent })));
  }));
  if (!categories.length) $('status').textContent = 'No spending in the last 12 months.';
} catch (e) { $('status').textContent = moneyFailure(e, 'load reports'); }

}
