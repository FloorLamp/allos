import {moneyFailure} from './failure.js';
// Faithful port of Purser overview.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { $, api, mountMoneyPage, money, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const { mountStatTiles } = await mountMoneyPage();
const tiles = mountStatTiles($('stats'), { onOpen: (href) => location.assign(href) });
try {
  const r = await api('/api/overview');
  $('period').textContent = `${r.from} – ${r.to}`;
  tiles.update({ tiles: [
    { key: 'spent', label: 'Spent this month', value: money(r.spent_cents, { sign: false }), sub: `${money(r.previous_cents, { sign: false })} through ${r.previousTo} last month`, ref: `/transactions?kind=spending&from=${r.from}&to=${r.to}` },
    { key: 'received', label: 'Received', value: money(r.received_cents, { sign: false }), sub: 'Income this month' },
    { key: 'reviews', label: 'To review', value: String(r.reviews), ref: '/review' },
    { key: 'uncategorised', label: 'Uncategorised', value: String(r.uncategorised), ref: '/transactions?category=none' },
  ] });
} catch (e) { $('status').textContent = moneyFailure(e, 'load overview'); }

try {
  const state = await api('/api/link');
  const failing = state.connections.filter(c => c.status !== 'ok');
  const banner = ctx.el('p', {role: 'status', className: 'dm-sync-health'},
    ctx.el('a', {href: '/accounts/connections', textContent: failing.length ? `${failing.length} bank connections need attention` : state.connections.length ? 'Bank connections are syncing' : 'No bank connections linked'}));
  $('stats').before(banner);
} catch (e) { $('status').textContent = moneyFailure(e, 'load sync health'); }
}
