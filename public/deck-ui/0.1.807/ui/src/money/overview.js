import {countText, dateRange, dateText, plural} from '../format.js';
import {amountQuantity, spentQuantity, spentText} from './labels.js';
// The Money overview (`/`): this month's spending against the same days last month, money received, what needs a decision.
export async function mount(ctx) {
  const { $, api, mountMoneyPage, location } = ctx;
const { mountStatTiles } = await mountMoneyPage();
const tiles = mountStatTiles($('stats'), { onOpen: (href) => location.assign(href) });
const now = new Date();
try {
  const r = await api('/api/overview');
  $('period').textContent = dateRange(r.from, r.to, { now });
  tiles.update({ tiles: [
    { key: 'spent', label: 'Spent this month', quantity: spentQuantity(r.spent_cents),
      sub: `${spentText(r.previous_cents)} by ${dateText(r.previousTo, { now })} last month${r.spent_cents < 0 ? ' · more refunded than spent' : ''}`,
      ref: `/transactions?kind=spending&from=${r.from}&to=${r.to}` },
    { key: 'received', label: 'Received', quantity: amountQuantity(r.received_cents), sub: 'Income this month', ref: `/transactions?kind=income&from=${r.from}&to=${r.to}` },
    { key: 'reviews', label: 'To review', value: countText(r.reviews), ref: '/review' },
    { key: 'uncategorised', label: 'Uncategorized', value: countText(r.uncategorised), ref: '/transactions?category=none&kind=all' },
  ] });
} catch (e) { ctx.fail(e); return; }

try {
  const state = await api('/api/link');
  const failing = state.connections.filter(c => c.status !== 'ok');
  const banner = ctx.el('p', {role: 'status', className: `dm-sync-health${failing.length ? ' warn' : ''}`},
    ctx.el('a', {className: 'link', href: '/accounts/connections', textContent: failing.length ? `${plural(failing.length, 'bank connection')} ${failing.length === 1 ? 'needs' : 'need'} attention` : state.connections.length ? 'Bank connections are up to date' : 'No bank connections linked'}));
  $('stats').before(banner);
} catch { /* the connections line is extra: the page stands without it */ }
}
