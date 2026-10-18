// Faithful port of Purser merchants.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { $, api, mountMoneyPage, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const { mountRows, money: moneyQuantity, host } = await mountMoneyPage();
const list = mountRows($('rows'), host, { loading: 8 });
try {
  const r = await api('/api/spending?group=merchant&grain=month');
  $('period').textContent = `${r.from} – ${r.to} · Last 12 months · Refunds net against spending`;
  const groups = new Map();
  for (const x of r.items) {
    if (!groups.has(x.id)) groups.set(x.id, { id: x.id, name: x.name, total: 0 });
    groups.get(x.id).total += x.spending_cents;
  }
  const merchants = [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const draw = () => {
    const q = $('search').value.trim().toLocaleLowerCase();
    const matches = merchants.filter((m) => m.name.toLocaleLowerCase().includes(q));
    $('status').textContent = `${matches.length} merchants`;
    list.update({ loading: 0, items: matches.map((m) => ({ id: String(m.id), glyph: null, title: m.name,
      sub: 'Net spending · Last 12 months', quantity: moneyQuantity(-m.total / 100),
      href: m.id === null ? '/reports' : `/merchant?id=${m.id}` })),
      empty: { title: 'No merchants', line: q ? 'Try another search.' : 'No spending in the last 12 months.' } });
  };
  $('search').addEventListener('input', draw);
  draw();
} catch (e) { list.update({ loading: 0, error: { title: 'Could not load merchants', line: e.message } }); }

}
