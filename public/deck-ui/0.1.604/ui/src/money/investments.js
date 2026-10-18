// Faithful port of Purser investments.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, deckUi, el, quantity, post, session, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const [{ mountRows, mountStatTiles, host }, { Chart }, { h, render }] = await Promise.all([
  mountMoneyPage(), deckUi('ui/src/view/chart.js'), deckUi('ui/vendor/preact.mjs'),
]);
const lists = Object.fromEntries(['holdings', 'balances', 'activity', 'documents'].map((id) => [id, mountRows($(id), host, { loading: 2 })]));
const value = (cents, currency) => quantity(cents === null ? null : cents / 100, currency, { currency: true });
$('year').value = new Date().getFullYear();
$(`export`).onsubmit = (ev) => { ev.preventDefault(); location.assign(`/api/investments/gains.csv?year=${encodeURIComponent($('year').value)}`); };
try {
  const v = await api('/api/investments');
  if ((await session()).owner) {
    $('owner-actions').hidden = false;
    for (const name of ['crypto-account', 'document-account']) $(name).replaceChildren(
      ...(name === 'crypto-account' ? [el('option', { value: 'new', textContent: 'New exchange account' })] : []),
      ...v.investmentAccounts.map((a) => el('option', { value: a.id, textContent: a.name })));
    const save = async (action) => {
      try { await action(); location.reload(); } catch (e) { $('status').textContent = e.message; }
    };
    $(`crypto-import`).onsubmit = (ev) => {
      ev.preventDefault();
      const a = $('crypto-account').value;
      save(async () => post(`/api/investments/import`, { account_id: a === 'new' ? 'new' : Number(a), csv: await $('crypto-file').files[0].text() }));
    };
    $('document-link').onsubmit = (ev) => {
      ev.preventDefault(); save(() => post('/api/investments/document', { account_id: Number($('document-account').value), bridge_doc_id: Number($('document-id').value) }));
    };
  }
  const names = new Map(v.balances.map((b) => [b.account_id, b.name]));
  const total = new Map();
  for (const x of v.holdings) total.set(x.currency, (total.get(x.currency) ?? 0) + (x.value_cents ?? 0));
  lists.holdings.update({ loading: 0, empty: { title: 'No holdings yet', line: 'Link an investment account to receive holdings.' }, items: v.holdings.map((x) => ({
    id: `${x.account_id}:${x.security_id}`, glyph: 'chart', title: x.name ?? x.symbol ?? x.security_id,
    sub: `${names.get(x.account_id) ?? x.account_id} · ${quantity(x.quantity, x.symbol ?? 'units')} · basis ${value(x.basis_cents, x.currency)} · as of ${x.as_of ?? 'unknown'}`,
    badge: { text: `${value(x.value_cents, x.currency)} · ${x.value_cents !== null && total.get(x.currency) ? (100 * x.value_cents / total.get(x.currency)).toFixed(1) + '%' : 'unknown allocation'}` },
  })) });
  lists.balances.update({ loading: 0, empty: { title: 'No observed balances yet' }, items: v.balances.map((x) => ({
    id: String(x.account_id), glyph: 'statement', title: x.name, sub: `${x.type ?? 'account'} · as of ${x.as_of}`, badge: { text: value(x.balance_cents, x.currency) },
  })) });
  lists.activity.update({ loading: 0, empty: { title: 'No investment activity yet' }, items: v.transactions.map((x) => ({
    id: String(x.id), glyph: 'chart', title: `${x.kind}${x.subtype ? ` · ${x.subtype}` : ''}`, sub: `${x.date} · ${quantity(x.quantity, 'units')} · ${names.get(x.account_id) ?? x.account_id}`,
    badge: { text: value(x.amount_cents, x.currency) },
  })) });
  lists.documents.update({ loading: 0, empty: { title: 'No statements linked yet' }, items: v.documents.map((x) => ({
    id: `${x.account_id}:${x.bridge_doc_id}`, glyph: 'statement', title: `Statement · ${names.get(x.account_id) ?? x.account_id}`, href: `https://deck.wang.team/doc/${x.bridge_doc_id}`,
  })) });
  for (const currency of new Set(v.netWorth.map((x) => x.currency))) {
    const points = v.netWorth.filter((x) => x.currency === currency), last = points.at(-1);
    const tiles = el('div');
    mountStatTiles(tiles, { tiles: [['Assets', last.assets_cents], ['Liabilities', last.liabilities_cents], ['Net worth', last.net_cents]]
      .map(([label, n]) => ({ key: label, label, value: value(last.unknown || last.unobserved_accounts ? null : n, currency) })) });
    const chart = el('div'); $('net-worth').append(tiles, el('p', { className: 'meta', textContent: `${last.day} · ${last.unknown} unknown balances · ${last.unobserved_accounts} unobserved accounts` }), chart);
    render(h(Chart, { data: { title: `Observed net worth · ${currency}`, valueName: 'Net worth', unit: currency,
      points: points.filter((x) => !x.unknown && !x.unobserved_accounts).map((x) => ({ period: x.day, value: x.net_cents / 100 })) } }), chart);
  }
  $('status').textContent = 'Daily observed balances; currencies are separate. Accounts without a balance are excluded. Each account shows its observation date.';
} catch (e) {
  $('status').textContent = 'Could not load investments.';
  for (const list of Object.values(lists)) list.update({ loading: 0, error: { title: 'Investments unavailable', line: e.message } });
}

}
