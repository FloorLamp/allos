import {dateTimeText, plural} from '../format.js';
import {connectionStatus, needsRelink} from './connection-status.js';
import {moneyFailure} from './failure.js';
import {ownerNotice} from './labels.js';
// Faithful port of Purser link.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { $, api, post, el, session: getSession, mountMoneyPage, day, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
// Connections (`/accounts/connections`, and `/link/oauth` where an OAuth bank sends the browser back): Plaid Link in the owner's browser, each connection's
// state, the owner's confirmation of each account onto the ledger's, relinking (update mode) and sync now. Everyone on the family
// network reads it; every button is the owner's (the server checks; this page only hides them).

const { mountRows, host } = await mountMoneyPage();
const rows = mountRows($('connections'), host, { loading: 2, search: false });
const PENDING = 'purser.link';
const when = (iso) => (iso ? dateTimeText(iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`, { now: new Date() }) : 'not yet');
let owner = false, state;

const plaidLink = () => ctx.owner.plaid.load();

// Opens Link with a token; `redirect` is this page's address when an OAuth bank has sent the browser back to it.
async function open(token, connection, redirect) {
  const Plaid = await plaidLink();
  Plaid.create({
    token, receivedRedirectUri: redirect,
    onSuccess: async (public_token, metadata) => {
      localStorage.removeItem(PENDING);
      history.replaceState(null, '', '/accounts/connections');
      try {
        if (connection) await post('/api/link/relinked', { connection });
        else await post('/api/link/exchange', { public_token, institution: metadata.institution });
      } catch (e) { alert(moneyFailure(e, 'update connections')); }
      await load();
    },
    onExit: () => { localStorage.removeItem(PENDING); if (redirect) history.replaceState(null, '', '/accounts/connections'); },
  }).open();
}

async function start(connection, product = 'transactions') {
  const { link_token } = await post('/api/link/token', connection ? { connection } : { product });
  localStorage.setItem(PENDING, JSON.stringify({ link_token, connection: connection ?? null }));
  await open(link_token, connection, undefined);
}

const button = (text, fn) => el('button', { className: 'btn', type: 'button', textContent: text, onclick: async (ev) => {
  ev.target.disabled = true;
  try { await fn(); } catch (e) { alert(moneyFailure(e, 'update connections')); }
  ev.target.disabled = false;
} });

function mapping(c) {
  const todo = c.accounts.filter((a) => !a.confirmed);
  const picks = new Map(todo.map((a) => {
    const s = el('select', { className: 'pick', ariaLabel: `Ledger account for ${a.name}` }, el('option', { value: '', textContent: 'Do not track' }),
      el('option', { value: 'new', textContent: 'A new account' }), ...state.accounts.map((l) => el('option', { value: l.id, textContent: l.name, selected: l.id === a.suggest })));
    s.disabled = !owner;
    return [a, s];
  }));
  const choose = (a) => { const v = picks.get(a).value; return { plaid_account_id: a.plaid_account_id, account_id: v === '' ? null : v === 'new' ? 'new' : Number(v) }; };
  return el('div', { className: 'item' }, el('div', { className: 'what', textContent: `${c.institution}: which ledger account is each?` }),
    ...todo.map((a) => el('div', { className: 'acts' }, el('span', { textContent: `${a.name}${a.mask ? ` ···${a.mask}` : ''}` }), picks.get(a))),
    owner ? el('div', { className: 'acts' }, button('Confirm', async () => { await post('/api/link/accounts', { connection: c.id, map: todo.map(choose) }); await load(); })) : null);
}

async function load() {
  state = await api('/api/link');
  const waiting = state.connections.filter((c) => c.accounts.some((a) => !a.confirmed));
  $('summary').textContent = state.configured ? `${plural(state.connections.length, 'connection')}${state.env && state.env !== 'production' ? ` · Plaid ${state.env}` : ''}` : 'Bank linking isn’t set up on this server yet.';
  rows.update({ loading: 0, empty: { title: 'Nothing linked yet', line: 'Link a bank to sync its transactions daily.', glyph: 'statement' }, items: state.connections.map((c) => {
    const lap = c.accounts.map((a) => a.overlap).filter(Boolean), sum = (k) => lap.reduce((n, o) => n + o[k], 0);
    // the next step once: Reconnect on the row for the owner, else its state
    const relink = owner && state.configured && needsRelink(c);
    return { id: String(c.id), glyph: 'statement', title: c.institution ?? 'Institution',
      ...(relink ? { end: { label: connectionStatus(c).split(' ')[0], onClick: () => start(c.id).catch((e) => alert(moneyFailure(e, 'update connections'))) } } : { badge: { text: connectionStatus(c), tone: c.status === 'ok' ? 'ok' : 'warn' } }),
      sub: [`last sync ${when(c.last_ok_at)}`, `${c.accounts.filter((a) => a.account_id).length} of ${c.accounts.length} accounts tracked`,
        c.consent_expires_at ? `consent ends ${day(c.consent_expires_at.slice(0, 10))}` : null,
        lap.length ? `overlap: ${sum('matched')} matched, ${sum('simplifiOnly')} Simplifi only, ${sum('liveOnly')} live only` : null].filter(Boolean).join(' · '),
      notes: [] };
  }) });
  $('mapping').hidden = !waiting.length;
  $('mapping').replaceChildren(...waiting.map(mapping));
  $('acts').replaceChildren(...(owner && state.configured ? [button('Link a bank', () => start()), button('Link investments', () => start(undefined, 'investments')), button('Link liabilities', () => start(undefined, 'liabilities')), button('Sync now', async () => { await post('/api/link/sync', {}); await load(); })] : []));
}

const who = await getSession().catch(() => ({ owner: false }));
owner = who.owner;
if (!owner) { $('signin').hidden = false; $('signin').replaceChildren(ownerNotice(ctx, who, 'Sign in as the owner to link or reconnect banks.')); }
try { await load(); } catch (e) { return ctx.fail(e); }
// an OAuth bank sent the browser back: Link carries on with the token it started with
if (owner && location.search.includes('oauth_state_id=')) {
  const p = JSON.parse(localStorage.getItem(PENDING) ?? 'null');
  if (p) await open(p.link_token, p.connection ?? undefined, location.href);
}

}
