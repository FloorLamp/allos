import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPurchases} from '../purchases.js';
import {amountText} from '../quantity.js';
import {dateText, joinText} from '../format.js';
import {Field} from './controls.js';
import {CollectionPager} from './collection-page.js';
import {Section} from './drawer.js';
import {PageHeader} from './page-header.js';
import {RowList} from './rows.js';
import {EntityLink} from './entity-link.js';
import {LinkToThing} from './thing-links.js';
import {Toast, useOutcome} from './toast.js';
import {canLink, createThing} from '../thing-links.js';
import {describeFailure} from '../failure.js';
const html = htm.bind(h);

/** A purchase as a shared row: what bridge has, nothing for what it lacks. Its charges stay notes beside the purchase amount, never
 *  added to it (contract/purchases.md). */
export const purchaseRow = (p, onOpen, links = null) => ({
  id: p.id, glyph: 'order', title: p.name,
  sub: joinText([p.merchant, dateText(p.date), amountText(p.total), p.category?.path ?? 'Uncategorized', p.orderNumber && `Order ${p.orderNumber}`]),
  // bridge's charges are ledger amounts (money out is negative); a purchase's charge reads as what was paid
  ...(p.charges?.length ? {summary: `Charged ${p.charges.map(c => joinText([amountText(Number.isFinite(c.amount) ? {...c, amount: Math.abs(c.amount)} : c), dateText(c.date), c.account])).join('; ')}`} : {}),
  ...(p.document || links?.write || p.thing ? {actions: purchaseActions(p, onOpen, links ?? {})} : {}),
});

/** A purchase's row actions, the shared buttons under its lines (none a column of its own): its Receipt, its thing (bridge's `thing`:
 *  the one physical thing it bought, `/things#<UUID>`), and for a member who may write: This is… (an existing thing, the shared
 *  picker) and New thing (one named as the purchase). */
function purchaseActions(p, onOpen, {host, write, busy, thisIs, newThing}) {
  // the site links the thing's page; a desktop's window has no pages, so there it is its name
  const name = p.thing && (host?.kind === 'web' ? html`<${EntityLink} kind="thing" id=${p.thing.id} label=${p.thing.name} />` : p.thing.name);
  const linked = p.thing ? html`<span>Thing: ${name}${p.thing.by === 'rule' ? ' · found by rule' : ''}</span>` : null;
  const receipt = p.document ? html`<button type="button" class="dk-btn" onClick=${() => onOpen?.(p.document)}>Receipt</button>` : null;
  if (!write) return html`${linked}${receipt}`;
  return html`${linked}${receipt}<button type="button" class="dk-btn" disabled=${busy} aria-label=${`This is… ${p.name}`} onClick=${() => thisIs(p)}>This is…</button>
    ${p.thing ? null : html`<button type="button" class="dk-btn" disabled=${busy} aria-label=${`New thing: ${p.name}`} onClick=${() => newThing(p)}>${busy ? 'Creating…' : 'New thing'}</button>`}`;
}

/** Purchases: the page (`/purchases`) or, `embedded` in Things, a section of it that Things' Refresh reloads (`refreshKey` changes). */
export function Purchases({host, onOpen, embedded = false, refreshKey = 0}) {
  const [model] = useState(() => createPurchases(host));
  const [, redraw] = useState(0);
  useEffect(() => {
    const unsubscribe = model.subscribe(() => redraw(n => n + 1));
    model.refresh();
    return () => { unsubscribe(); model.stop(); };
  }, [model]);
  const shownKey = useRef(refreshKey);
  useEffect(() => { if (refreshKey !== shownKey.current) { shownKey.current = refreshKey; model.refresh(); } }, [refreshKey]);
  const refresh = html`<button class="dk-btn" type="button" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`;
  // the other side of a thing's links: which thing a purchase bought (contract/purchases.md *Things*)
  const [picking, setPicking] = useState(null), [creating, setCreating] = useState(null), [outcome, say] = useOutcome();
  const newThing = async p => {
    setCreating(p.id);
    try {
      const answer = await createThing(host, {name: p.name, from: {kind: 'purchase', id: p.id}});
      model.linked(p.id, {id: answer.thing.id, name: answer.thing.name, by: 'owner'});
      say(`New thing: ${answer.thing.name}`);
    } catch (e) { say(describeFailure('bridge', e).message, true); }
    setCreating(null);
  };
  const links = {host, write: canLink(host), thisIs: setPicking, newThing};
  const charged = model.results.some(p => p.charges?.length);
  const body = html`
    ${model.categories.length || model.category ? html`<div class="dk-purchases-filter"><${Field} as="select" label="Category" value=${model.category} disabled=${model.loading}
      onChange=${e => model.refresh({category: e.currentTarget.value})}>
      <option value="">All categories</option>
      ${model.categories.map(c => html`<option key=${c.id} value=${c.id}>${c.path}</option>`)}
    <//></div>` : null}
    <${RowList} card=${true} host=${host} inline=${embedded} warming=${model.warming} items=${model.results.map(p => purchaseRow(p, onOpen, {...links, busy: creating === p.id}))} loading=${model.loading && !model.results.length ? 3 : 0}
      error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null}
      empty=${{glyph: 'order', title: model.category ? 'No purchases in this category' : 'No purchases yet'}} />
    <${CollectionPager} label="Purchase pages" page=${{page: model.page, pages: null, more: model.more, busy: model.loading, turn: n => model.turn(n),
      start: model.page * model.size, end: model.page * model.size + model.results.length}} />
    ${charged ? html`<p class="dk-purchases-note">A linked charge may cover several purchases; it is never added to their amounts.</p>` : null}
    ${picking ? html`<${LinkToThing} host=${host} title="This is…" target=${{kind: 'purchase', id: picking.id, title: picking.name}} current=${picking.thing}
      onClose=${() => setPicking(null)} onLinked=${thing => { model.linked(picking.id, {...thing, by: 'owner'}); say(`Linked to ${thing.name}`); setPicking(null); }} />` : null}
    <${Toast} outcome=${outcome} />`;
  return embedded
    ? html`<${Section} class="dk-section dk-purchases" title="Purchases" aria-busy=${model.loading}>${body}<//>`
    : html`<main class="dk-purchases dk-page" aria-label="Purchases" aria-busy=${model.loading}>
      <${PageHeader} title="Purchases" description="What we bought, with receipts and linked charges." actions=${refresh} />${body}</main>`;
}
