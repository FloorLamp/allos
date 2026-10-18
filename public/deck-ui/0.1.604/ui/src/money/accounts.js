// Faithful port of Purser accounts.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { $, api, post, el, session, mountMoneyPage, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const { mountRows, mountDrawer, host } = await mountMoneyPage();
const { h } = await ctx.deckUi('ui/vendor/preact.mjs');
const drawerRoot = el('div'); document.body.append(drawerRoot);
const drawer = mountDrawer(drawerRoot, {open: false});
let accountState, detailRequest = 0;
const detailURL = ctx.detailURL('detail', async id => {
  const request = ++detailRequest;
  if (!id) { drawer.update({open: false}); return; }
  const a = accountState?.accounts.find(a => String(a.id) === id);
  if (!a) return;
  const connections = accountState.plaid.filter(p => p.account_id === a.id);
  const content = log => h('div', {},
    h('h3', {}, 'History'), h('p', {}, `${a.count} transactions · ${a.history_from ?? 'No imported history'}${a.history_to ? ` – ${a.history_to}` : ''}`),
    h('h3', {}, 'Connection status'),
    ...(connections.length ? connections.map(p => h('p', {}, `${p.name} · ${p.status} · ${p.ignored ? 'Imports ignored' : 'Mapped'}`)) : [h('p', {}, 'No bank connection')]),
    h('h3', {}, 'Import log'), h('p', {}, 'Ledger import runs (all accounts)'),
    ...log,
    h('a', {href: `/transactions?account=${a.id}&kind=all`}, 'View transactions'));
  drawer.update({open: true, title: a.name, onClose: () => detailURL.close(), children: content([h('p', {role: 'status'}, 'Loading imports…')])});
  try {
    const {imports} = await api('/api/imports');
    if (request !== detailRequest) return;
    drawer.update({children: content(imports.length ? imports.map(i => h('p', {}, `${i.source} · ${i.finished_at ?? 'unfinished'} · ${i.rows_new} new rows${i.error ? ` · ${i.error}` : ''}`)) : [h('p', {}, 'No imports yet')])});
  } catch (e) { if (request === detailRequest) drawer.update({children: content([h('p', {role: 'alert'}, e.message)])}); }
});
const owner = (await session()).owner;
$('signin').hidden = owner;
const pick = (label, values, value) => el('label', { textContent: `${label} ` }, el('select', { className: 'pick', ariaLabel: label }, ...values.map(([v, text]) => el('option', { value: v, textContent: text, selected: String(value) === String(v) }))));
const button = (text, body) => el('button', { className: 'btn', textContent: text, onclick: async () => {
  try {
    const b = typeof body === 'function' ? body() : body;
    const preview = await post('/api/account-change', { ...b, preview: true });
    if (!confirm(`${text}: ${preview.rows} transaction rows affected. Apply?`)) return;
    await post('/api/account-change', b);
    await load();
  } catch (e) { $('summary').textContent = `Could not save: ${e.message}`; }
} });
async function load() {
  const state = await api('/api/account-management');
  accountState = state;
  const groups = new Map();
  for (const a of state.accounts) {
    const institution = a.institution ?? 'Institution not set';
    if (!groups.has(institution)) groups.set(institution, []);
    groups.get(institution).push(a);
  }
  for (const p of state.plaid.filter((p) => !p.account_id)) {
    const institution = p.institution ?? 'Institution not set';
    if (!groups.has(institution)) groups.set(institution, []);
  }
  $('summary').textContent = `${state.accounts.length} ledger accounts · ${state.plaid.length} Plaid accounts`;
  $('connections').replaceChildren();
  for (const [institution, accounts] of groups) {
    $('connections').append(el('h2', { className: 'label', textContent: institution }));
    for (const a of accounts) {
      const box = el('div', { className: 'panel' });
      $('connections').append(box);
      // Rows constructs asynchronously; its renderer owns only the summary container.
      const summary = el('div'); box.append(summary);
      mountRows(summary, host, { onOpen: item => detailURL.open(item.id), items: [{ id: String(a.id), title: a.name, glyph: 'statement',
        sub: `${a.person} · ${a.type === 'credit' ? 'card' : a.type ?? 'type not set'} · ${a.hidden ? 'hidden' : a.closed_on ? `closed ${a.closed_on}` : 'open'} · ${a.count} transactions${a.history_from ? ` · Simplifi ${a.history_from} – ${a.history_to}` : ''}${a.type === 'investment' ? ' · excluded from spending' : ''}` }] });
      if (owner) {
        const name = el('input', { className: 'pick', ariaLabel: 'Display name', value: a.name });
        const person = pick('Person', state.people.map((v) => [v, v]), a.person);
        const type = pick('Type', ['checking', 'savings', 'credit', 'loan', 'investment'].map((v) => [v, v === 'credit' ? 'card' : v]), a.type);
        const date = el('input', { type: 'date', ariaLabel: 'Closed date', value: a.closed_on ?? '' });
        const hidden = pick('Visibility', [[0, 'Visible'], [1, 'Hidden']], a.hidden);
        box.append(el('div', { className: 'acts dm-account-editor' }, el('label', { className: 'dm-account-name', textContent: 'Display name ' }, name), person, type, el('label', { textContent: 'Closed date (blank for open) ' }, date), hidden,
          button('Save account', () => ({ action: 'update', account: a.id, values: { name: name.value, person: person.querySelector('select').value, type: type.querySelector('select').value, closed_on: date.value || null, hidden: Number(hidden.querySelector('select').value) } }))));
      }
      for (const p of state.plaid.filter((p) => p.account_id === a.id)) box.append(connection(p, state));
    }
    for (const p of state.plaid.filter((p) => !p.account_id && (p.institution ?? 'Institution not set') === institution)) $('connections').append(connection(p, state));
  }
}
function connection(p, state) {
  const box = el('div', { className: 'item' }, el('p', { className: 'meta', textContent: `${p.name} · Plaid Item ${p.plaid_item_id} · ${p.status} · ${p.type ?? ''}/${p.subtype ?? ''} · ${p.ignored ? 'ignored' : p.account_id ? 'mapped' : 'unmapped'} · ${p.count} raw rows` }));
  if (owner) {
    const mapping = pick('Ledger account', [['', 'Unmapped'], ...state.accounts.map((a) => [a.id, a.name])], p.account_id ?? '');
    const base = { connection: p.connection_id, plaid_account_id: p.plaid_account_id };
    box.append(el('div', { className: 'acts' }, mapping, button('Save mapping', () => ({ ...base, action: 'map', account: mapping.querySelector('select').value ? Number(mapping.querySelector('select').value) : null })),
      button(p.ignored ? 'Restore imports' : 'Ignore account', { ...base, action: p.ignored ? 'restore' : 'ignore' })));
  }
  return box;
}
try { await load(); detailURL.sync(); } catch (e) { $('summary').textContent = e.message; }

}
