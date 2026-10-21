import {dateRange} from '../format.js';
import {spentQuantity} from './labels.js';
// By merchant (`/spending/merchants`): each merchant's net spending over the last 12 months, largest first, with the page's own search.
export async function mount(ctx) {
  const { $, api, mountMoneyPage } = ctx;
const { mountRows, host } = await mountMoneyPage();
const list = mountRows($('rows'), host, { loading: 8, search: false });
try {
  const r = await api('/api/spending?group=merchant&grain=month');
  $('period').textContent = `${dateRange(r.from, r.to, { now: new Date() })} · Last 12 months · Refunds net against spending`;
  const groups = new Map();
  for (const x of r.items) {
    if (!groups.has(x.id)) groups.set(x.id, { id: x.id, name: x.name, total: 0 });
    groups.get(x.id).total += x.spending_cents;
  }
  const merchants = [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  if (!merchants.length) return ctx.empty({ title: 'No spending yet', line: 'Merchants show here once the last 12 months have spending.', glyph: 'receipt' });
  const draw = () => {
    const q = $('search').value.trim().toLocaleLowerCase();
    const matches = merchants.filter((m) => m.name.toLocaleLowerCase().includes(q));
    $('status').textContent = q ? `${matches.length} of ${merchants.length} merchants` : `${merchants.length} merchants`;
    list.update({ loading: 0, items: matches.map((m) => ({ id: String(m.id), glyph: null, title: m.name, quantity: spentQuantity(m.total),
      href: m.id === null ? '/spending' : `/spending/merchant?id=${m.id}` })),
      empty: { title: 'No matches', line: 'Try another search.' } });
  };
  $('search').addEventListener('input', draw);
  draw();
} catch (e) { ctx.fail(e); }

}
