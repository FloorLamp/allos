import {moneyFailure} from './failure.js';
// Faithful port of Purser subscriptions.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { $, api, post, session, el, mountMoneyPage, money, day, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
const { mountRows, host } = await mountMoneyPage();
const rows = mountRows($('subscriptions'), host, { loading: 3 });
async function load() {
  const [{ subscriptions }, who] = await Promise.all([api('/api/subscriptions'), session()]);
  rows.update({ loading: 0, empty: { title: 'No subscriptions detected', line: 'Three occurrences are needed; two for annual charges.' }, items: subscriptions.map((s) => ({
    ...s.row, href: undefined,
    sub: `${s.cadence} · ${money(s.amount_typical)}${s.amount_tolerance === null ? ' · variable bill' : ''} · ${s.state}`,
    notes: [{ text: `Next due ${day(s.next_due)} · Last seen ${day(s.last_seen)}` },
      { text: 'Cancel-by unknown; check the provider’s renewal terms.' },
      ...s.price_changes.map((p) => ({ text: `Price change ${day(p.posted_on)}: ${money(p.amount_cents)}`, tone: 'warn' })),
      ...s.links.map((l) => ({ text: `${l.kind} · bridge document ${l.bridge_doc_id}` }))],
  })) });
  $('actions').replaceChildren(...subscriptions.map((s) => el('div', { className: 'panel' }, el('h2', { textContent: s.merchant }),
    ...s.links.map((l) => el('a', { href: `https://deck.wang.team/doc/${l.bridge_doc_id}`, textContent: `Open ${l.kind} document ${l.bridge_doc_id}` })),
    ...['active', 'stopped', 'ignored'].map((state) => {
      const button = el('button', { textContent: `Mark ${state}`, disabled: !who.owner || s.state === state });
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await post(`/api/subscription/${s.id}`, { state }); await load(); }
        catch (e) { $('status').textContent = moneyFailure(e, 'update subscriptions'); button.disabled = false; }
      });
      return button;
    }))));
  $('status').textContent = who.owner ? '' : 'Sign in as the owner to change a subscription’s state.';
}
try { await load(); } catch (e) { rows.update({ loading: 0, error: { title: 'Could not load subscriptions', line: moneyFailure(e, 'update subscriptions') } }); }

}
