import {moneyFailure} from './failure.js';
// Faithful port of Purser investments.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, deckUi, el, quantity, day, post, session, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
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
      try { await action(); location.reload(); } catch (e) { $('status').textContent = moneyFailure(e, 'update investments'); }
    };
    $(`crypto-import`).onsubmit = (ev) => {
      ev.preventDefault();
      const a = $('crypto-account').value;
      save(async () => post(`/api/investments/import`, { account_id: a === 'new' ? 'new' : Number(a), csv: await $('crypto-file').files[0].text() }));
    };
    const query = $('document-query'), choice = $('document-choice'), account = $('document-account');
    const search = $('document-search'), submit = $('document-submit'), status = $('document-status');
    let generation = 0, documents = new Map(), saving = false;
    const reset = () => {
      generation++; documents.clear(); choice.replaceChildren(); choice.disabled = true; submit.disabled = true;
    };
    const describe = () => {
      const selected = documents.get(choice.value);
      submit.disabled = saving || !selected || !account.value;
      if (selected) status.textContent = `Link “${selected.title || 'Untitled statement'}” to ${account.selectedOptions[0].textContent}.`;
    };
    query.oninput = () => { reset(); status.textContent = 'Search again to choose a statement.'; };
    account.onchange = () => { reset(); status.textContent = 'Account changed. Search and choose a statement for this account.'; };
    choice.onchange = describe;
    const find = async () => {
      reset();
      const q = query.value.trim(), run = generation;
      if (!q) { status.textContent = 'Enter a title, account or date to search Bridge.'; return; }
      if (!account.value) { status.textContent = 'No investment accounts available to link a statement.'; return; }
      status.textContent = 'Searching Bridge…';
      try {
        const answer = await host.call('bridge.find', {q, limit: 50});
        if (run !== generation) return;
        for (const result of answer.results ?? []) {
          const d = result.document;
          if (result.kind === 'document' && Number.isSafeInteger(d?.id) && d.id > 0) documents.set(String(d.id), d);
        }
        choice.replaceChildren(el('option', {value: '', textContent: 'Choose a statement'}),
          ...[...documents].map(([id, d]) => el('option', {value: id,
            textContent: [d.title || 'Untitled statement', d.date ? day(d.date) : null, d.source].filter(Boolean).join(' · ')})));
        choice.disabled = !documents.size;
        status.textContent = documents.size ? `${documents.size} documents found. Choose the statement for ${account.selectedOptions[0].textContent}.` : 'No documents found. Try another title, account or date.';
      } catch {
        if (run === generation) status.textContent = 'Could not search Bridge. Try Search statements again.';
      }
    };
    search.onclick = find;
    query.onkeydown = ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); find(); } };
    $('document-link').onsubmit = async ev => {
      ev.preventDefault();
      const selected = documents.get(choice.value), accountId = Number(account.value), run = generation;
      if (saving || !selected || !v.investmentAccounts.some(a => a.id === accountId)) return;
      saving = true; submit.disabled = true;
      status.textContent = 'Linking statement…';
      try {
        await host.call('bridge.doc', {id: selected.id});
        if (run !== generation) return;
        await post('/api/investments/document', {account_id: accountId, bridge_doc_id: selected.id});
        location.reload();
      } catch {
        status.textContent = 'Could not link statement. Check the account and selected document, then try again.';
      } finally { saving = false; submit.disabled = !documents.has(choice.value) || !account.value; }
    };
    if (!v.investmentAccounts.length) status.textContent = 'No investment accounts available to link a statement.';
  }
  const names = new Map(v.balances.map((b) => [b.account_id, b.name]));
  const total = new Map();
  for (const x of v.holdings) total.set(x.currency, (total.get(x.currency) ?? 0) + (x.value_cents ?? 0));
  lists.holdings.update({ loading: 0, empty: { title: 'No holdings yet', line: 'Link an investment account to receive holdings.' }, items: v.holdings.map((x) => ({
    id: `${x.account_id}:${x.security_id}`, glyph: 'chart', title: x.name ?? x.symbol ?? x.security_id,
    sub: `${names.get(x.account_id) ?? x.account_id} · ${quantity(x.quantity, x.symbol ?? 'units')} · basis ${value(x.basis_cents, x.currency)} · as of ${x.as_of ? day(x.as_of) : 'unknown'}`,
    badge: { text: `${value(x.value_cents, x.currency)} · ${x.value_cents !== null && total.get(x.currency) ? (100 * x.value_cents / total.get(x.currency)).toFixed(1) + '%' : 'unknown allocation'}` },
  })) });
  lists.balances.update({ loading: 0, empty: { title: 'No observed balances yet' }, items: v.balances.map((x) => ({
    id: String(x.account_id), glyph: 'statement', title: x.name, sub: `${x.type ?? 'account'} · as of ${day(x.as_of)}`, badge: { text: value(x.balance_cents, x.currency) },
  })) });
  lists.activity.update({ loading: 0, empty: { title: 'No investment activity yet' }, items: v.transactions.map((x) => ({
    id: String(x.id), glyph: 'chart', title: `${x.kind}${x.subtype ? ` · ${x.subtype}` : ''}`, sub: `${day(x.date)} · ${quantity(x.quantity, 'units')} · ${names.get(x.account_id) ?? x.account_id}`,
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
    const chart = el('div'); $('net-worth').append(tiles, el('p', { className: 'meta', textContent: `${day(last.day)} · ${last.unknown} unknown balances · ${last.unobserved_accounts} unobserved accounts` }), chart);
    render(h(Chart, { data: { title: `Observed net worth · ${currency}`, valueName: 'Net worth', unit: currency,
      points: points.filter((x) => !x.unknown && !x.unobserved_accounts).map((x) => ({ period: x.day, value: x.net_cents / 100 })) } }), chart);
  }
  $('status').textContent = 'Daily observed balances; currencies are separate. Accounts without a balance are excluded. Each account shows its observation date.';
} catch (e) {
  $('status').textContent = 'Could not load investments.';
  for (const list of Object.values(lists)) list.update({ loading: 0, error: { title: 'Investments unavailable', line: moneyFailure(e, 'load investments') } });
}

}
