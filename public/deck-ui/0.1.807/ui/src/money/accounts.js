import {countText, dateRange, plural} from '../format.js';
import {amountText as quantityAmount} from '../quantity.js';
import {connectionStatus, needsRelink} from './connection-status.js';
import {moneyFailure} from './failure.js';
import {accountTypeText, ownerNotice} from './labels.js';
// Accounts (`/accounts`): the ledger's accounts by institution, one list each, a bank account not tied to one beside them. A row opens
// the drawer: its balance, history and bank link, and for the owner its settings and the link's mapping.
export async function mount(ctx) {
  const { $, api, post, el, session, mountMoneyPage, day, document, confirm } = ctx;
const { mountRows, mountDrawer, host } = await mountMoneyPage();
const { h } = await ctx.deckUi('ui/vendor/preact.mjs');
const drawerRoot = el('div'); document.body.append(drawerRoot);
const drawer = mountDrawer(drawerRoot, {open: false});
let state, balances = [], latest = new Map(), detailRequest = 0;
const who = await session().catch(() => ({ owner: false }));
const owner = who.owner;
if (!owner) { $('signin').hidden = false; $('signin').replaceChildren(ownerNotice(ctx, who)); }

const balanceOf = a => balances.find(b => b.account_id === a.id);
const plaidName = p => `${p.name}${p.mask ? ` ···${p.mask}` : ''}`;
// a DOM form inside the drawer's Preact content
const holder = node => h('div', {ref: n => n && n.firstChild !== node && n.replaceChildren(node)});
const pick = (label, values, value) => el('label', { textContent: `${label} ` }, el('select', { className: 'pick', ariaLabel: label }, ...values.map(([v, text]) => el('option', { value: v, textContent: text, selected: String(value) === String(v) }))));
const button = (text, body, {primary = false} = {}) => el('button', { className: `btn${primary ? ' primary' : ''}`, type: 'button', textContent: text, onclick: async () => {
  try {
    const b = typeof body === 'function' ? body() : body;
    const preview = await post('/api/account-change', { ...b, preview: true });
    if (!confirm(`${text}: ${plural(preview.rows, 'transaction')} affected. Apply?`)) return;
    await post('/api/account-change', b);
    await load();
    detailURL.sync();
  } catch (e) { drawer.update({ sub: moneyFailure(e, 'update accounts') }); }
} });

function mappingForm(p) {
  const mapping = pick('Ledger account', [['', 'Not linked'], ...state.accounts.map((a) => [a.id, a.name])], p.account_id ?? '');
  const base = { connection: p.connection_id, plaid_account_id: p.plaid_account_id };
  return el('div', { className: 'acts dm-account-editor' }, mapping,
    button('Save link', () => ({ ...base, action: 'map', account: mapping.querySelector('select').value ? Number(mapping.querySelector('select').value) : null })),
    button(p.ignored ? 'Restore imports' : 'Ignore this account', { ...base, action: p.ignored ? 'restore' : 'ignore' }));
}

function accountForm(a) {
  const name = el('input', { className: 'pick', ariaLabel: 'Display name', value: a.name });
  const person = pick('Person', state.people.map((v) => [v, v === 'owner' ? 'Owner' : v]), a.person);
  const type = pick('Type', ['checking', 'savings', 'credit', 'loan', 'investment'].map((v) => [v, accountTypeText(v)]), a.type);
  const date = el('input', { type: 'date', ariaLabel: 'Closed date', value: a.closed_on ?? '' });
  const hidden = pick('Visibility', [[0, 'Visible'], [1, 'Hidden']], a.hidden);
  return el('div', { className: 'dm-account-editor' }, el('label', { className: 'dm-account-name', textContent: 'Display name ' }, name), person, type,
    el('label', { textContent: 'Closed (blank while open) ' }, date), hidden,
    button('Save account', () => ({ action: 'update', account: a.id, values: { name: name.value, person: person.querySelector('select').value, type: type.querySelector('select').value, closed_on: date.value || null, hidden: Number(hidden.querySelector('select').value) } }), {primary: true}));
}

const fact = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
const detailURL = ctx.detailURL('detail', async id => {
  const request = ++detailRequest;
  if (!id || !state) { drawer.update({open: false}); return; }
  const plaid = state.plaid.find(p => `plaid:${p.connection_id}:${p.plaid_account_id}` === id);
  if (plaid) {
    drawer.update({open: true, title: plaidName(plaid), sub: plaid.institution ?? 'Bank account', onClose: () => detailURL.close(), children: h('div', {},
      h('dl', {}, fact('Connection', connectionStatus(plaid)), fact('Ledger account', 'Not linked'), fact('Imports', plaid.ignored ? 'Ignored' : 'Waiting for a ledger account')),
      owner ? h('section', {}, h('h3', {}, 'Link to a ledger account'), holder(mappingForm(plaid))) : null)});
    return;
  }
  const a = state.accounts.find(a => String(a.id) === id);
  if (!a || request !== detailRequest) return;
  const b = balanceOf(a), links = state.plaid.filter(p => p.account_id === a.id);
  drawer.update({open: true, title: a.name, sub: [accountTypeText(a.type), a.institution].filter(Boolean).join(' · '), onClose: () => detailURL.close(), children: h('div', {},
    h('dl', {},
      fact('Balance', b?.balance_cents == null ? 'Not known yet' : `${quantityAmount({amount: b.balance_cents / 100, currency: b.currency})} · ${day(b.day)}`),
      fact('Transactions', a.count ? `${countText(a.count)} · ${dateRange(a.history_from?.slice(0, 10), a.history_to?.slice(0, 10), {now: new Date()})}` : a.type === 'investment' ? 'Trades are under Investments' : 'None yet'),
      fact('Last activity', latest.get(a.id) ? day(latest.get(a.id)) : 'None yet'),
      ...links.map(p => fact('Bank link', `${plaidName(p)} · ${connectionStatus(p)}${p.ignored ? ' · imports ignored' : ''}`)),
      a.hidden ? fact('Visibility', 'Hidden') : null, a.closed_on ? fact('Closed', day(a.closed_on)) : null),
    h('div', {className: 'acts dm-drawer-links'},
      h('a', {className: 'btn', href: `/transactions?account=${a.id}&kind=all`}, 'View transactions'),
      a.type === 'investment' ? h('a', {className: 'btn', href: '/accounts/investments'}, 'Investments') : null),
    owner ? h('section', {}, h('h3', {}, 'Settings'), holder(accountForm(a))) : null,
    ...(owner ? links.map(p => h('section', {key: p.plaid_account_id}, h('h3', {}, `Bank link · ${plaidName(p)}`), holder(mappingForm(p)))) : []))});
});

const lists = [];
async function load() {
  state = await api('/api/account-management');
  const [investments, activity] = await Promise.all([
    api('/api/investments'),
    Promise.all(state.accounts.map(async a => {
      const {items} = await api(`/api/txns?account=${a.id}&kind=all&sort=newest&limit=1`);
      return [a.id, items[0]?.date];
    })),
  ]);
  balances = investments.balances; latest = new Map(activity);
  for (const list of lists.splice(0)) list.unmount?.();
  $('connections').replaceChildren();
  if (!state.accounts.length && !state.plaid.length) {
    $('summary').textContent = '';
    return ctx.empty({ title: 'No accounts yet', line: 'Import a Simplifi export or link a bank, and its accounts show here.', glyph: 'statement',
      action: 'Connections', href: '/accounts/connections' });
  }
  const unlinked = state.plaid.filter((p) => !p.account_id);
  $('summary').textContent = [plural(state.accounts.length, 'account'), unlinked.length ? `${plural(unlinked.length, 'bank account')} not linked` : null].filter(Boolean).join(' · ');
  const groups = new Map();
  const group = name => groups.get(name) ?? groups.set(name, []).get(name);
  for (const a of state.accounts) group(a.institution ?? 'Other accounts').push({account: a});
  for (const p of unlinked) group(p.institution ?? 'Other accounts').push({plaid: p});
  for (const [institution, entries] of groups) {
    const box = el('section', { className: 'dm-account-group' }, el('h2', { textContent: institution }));
    const rows = el('div', { className: 'panel' });
    box.append(rows); $('connections').append(box);
    lists.push(mountRows(rows, host, { search: false, onOpen: item => detailURL.open(item.id), items: entries.map(({account: a, plaid: p}) => {
      if (p) return { id: `plaid:${p.connection_id}:${p.plaid_account_id}`, glyph: 'statement', title: plaidName(p), sub: 'Bank account not linked to the ledger',
        notes: p.ignored ? [{ text: 'Imports ignored' }] : needsRelink(p) ? [{ text: connectionStatus(p), tone: 'warn' }] : [] };
      const b = balanceOf(a), links = state.plaid.filter(x => x.account_id === a.id), failing = links.filter(x => x.status && x.status !== 'ok');
      return { id: String(a.id), glyph: 'statement', title: a.name,
        sub: [accountTypeText(a.type), latest.get(a.id) ? `Last activity ${day(latest.get(a.id))}` : 'No activity', a.hidden ? 'Hidden' : null, a.closed_on ? `Closed ${day(a.closed_on)}` : null].filter(Boolean).join(' · '),
        notes: failing.map(x => ({ text: connectionStatus(x), tone: 'warn' })),
        quantity: b?.balance_cents == null ? undefined : {value: b.balance_cents / 100, format: 'currency', unit: /^[A-Z]{3}$/.test(b.currency ?? '') ? b.currency : 'USD', tone: 'neutral'} };
    }) }));
  }
}
try { await load(); detailURL.sync(); } catch (e) { ctx.fail(e); }

}
