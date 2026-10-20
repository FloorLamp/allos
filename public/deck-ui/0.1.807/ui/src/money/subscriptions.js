import {fieldLabel, plural} from '../format.js';
import {moneyFailure} from './failure.js';
import {ownerNotice} from './labels.js';
// Recurring (`/spending/recurring`): payments that repeat, the typical amount trailing; a row opens the drawer with its schedule, price
// changes and documents, and for the owner its state (active, stopped, ignored) as one choice.
export async function mount(ctx) {
  const { $, api, post, session, el, mountMoneyPage, money, day, document } = ctx;
const { mountRows, mountDrawer, money: moneyQuantity, host } = await mountMoneyPage();
const { h } = await ctx.deckUi('ui/vendor/preact.mjs');
const rows = mountRows($('subscriptions'), host, { loading: 3, search: false, onOpen: (item) => detailURL.open(item.id) });
const drawerRoot = el('div'); document.body.append(drawerRoot);
const drawer = mountDrawer(drawerRoot, { open: false });
const STATES = [['active', 'Active'], ['stopped', 'Stopped'], ['ignored', 'Ignored']];
let subscriptions = [], who = { owner: false }, saving = false, error = '';

const fact = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
function show(id) {
  const s = subscriptions.find((x) => String(x.id) === id);
  if (!s) { drawer.update({ open: false }); return; }
  drawer.update({ open: true, title: s.merchant, sub: `${fieldLabel(s.cadence)} · ${STATES.find(([k]) => k === s.state)?.[1] ?? fieldLabel(s.state)}`, onClose: () => detailURL.close(),
    children: h('div', {},
      h('dl', {}, fact('Typical amount', `${money(s.amount_typical)}${s.amount_tolerance === null ? ', varies' : ''}`), fact('Next due', day(s.next_due)),
        fact('Last seen', day(s.last_seen)), fact('Cancel by', s.cancel_by ? day(s.cancel_by) : 'Not known; check the provider’s renewal terms'),
        ...s.price_changes.map((p, i) => fact(i ? '' : 'Price changes', `${day(p.posted_on)} · ${money(p.amount_cents)}`))),
      s.links.length ? h('section', {}, h('h3', {}, 'Documents'), h('div', { className: 'acts dm-drawer-links' },
        ...s.links.map((l) => h('a', { key: l.bridge_doc_id, className: 'btn', href: `https://deck.wang.team/doc/${l.bridge_doc_id}` }, `Open ${fieldLabel(l.kind).toLowerCase()}`)))) : null,
      who.owner ? h('section', {}, h('h3', {}, 'State'), h('div', { className: 'dm-choice', role: 'group', 'aria-label': 'State' },
        ...STATES.map(([state, label]) => h('button', { key: state, type: 'button', className: 'btn', 'aria-pressed': String(s.state === state), disabled: saving || s.state === state,
          onClick: async () => {
            saving = true; error = ''; show(id);
            try { await post(`/api/subscription/${s.id}`, { state }); await load(); } catch (e) { error = moneyFailure(e, 'update subscriptions'); }
            saving = false; show(id);
          } }, label))), h('p', { role: 'status' }, error)) : null) });
}
const detailURL = ctx.detailURL('detail', (id) => (id ? show(id) : drawer.update({ open: false })));

async function load() {
  [{ subscriptions }, who] = await Promise.all([api('/api/subscriptions'), session()]);
  rows.update({ loading: 0, empty: { title: 'No recurring payments found', line: 'A payment shows here after three occurrences, two for annual ones.', glyph: 'calendar' },
    items: subscriptions.map((s) => ({
      id: String(s.id), glyph: s.row?.glyph ?? 'calendar', title: s.merchant,
      sub: [fieldLabel(s.cadence), `next ${day(s.next_due)}`, s.state === 'active' ? null : STATES.find(([k]) => k === s.state)?.[1], s.amount_tolerance === null ? 'amount varies' : null].filter(Boolean).join(' · '),
      notes: s.price_changes.length ? [{ text: `${plural(s.price_changes.length, 'price change')}`, tone: 'warn' }] : [],
      quantity: moneyQuantity(s.amount_typical / 100),
    })) });
}
try { await load(); detailURL.sync(); } catch (e) { return ctx.fail(e); }
if (!who.owner) $('status').replaceChildren(ownerNotice(ctx, who, 'Sign in as the owner to change a payment’s state.'));

}
