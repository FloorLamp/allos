// A record (palette SPEC.md, *Kinds*: `record`; record.js reads it): an order, receipt, bill, statement or invoice that is no file,
// laid out from what bridge read instead of its text: who and when (merchant, date, number, status, its page), its items (the shared
// rows: a short name over quantity and shipping, the full name, the price; a click its product page), the amounts, shipping and
// payment (the shared facts list, money by the shared formatter), and the text bridge read behind `Source text`.
import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {dateText} from '../../format.js';
import {RowList} from '../rows.js';
import {Facts} from '../drawer.js';
import {Glyph} from '../../glyphs.js';
import {statusTone} from '../../status-tone.js';
import {Link} from './thing.js';
import {formatQuantity} from '../../quantity.js';

const html = htm.bind(h);
const times = (q, n) => q && n > 1 ? {...q, value: q.value * n} : q;

/** A card as a statement prints it (`Visa - 0000`), read as its brand and last digits: `Visa ···· 0000`. */
const cardText = text => String(text).replace(/^(.*?\S)\s*[-–]\s*(\d{4})$/u, '$1 ···· $2');

/** An item as a shared row: its short name over quantity, unit price and shipping, the full name under, its price at the end. */
export function itemRow(it, i) {
  const each = it.qty > 1 && it.price ? `${it.qty} × ${formatQuantity(it.price)}` : null;
  return {id: `item${i}`, glyph: 'order', title: it.short,
    sub: [it.qty && !each ? `Qty ${it.qty}` : each, it.status && it.shipped ? `${it.status} ${dateText(it.shipped)}` : it.status ?? (it.shipped ? `Shipped ${dateText(it.shipped)}` : null),
      it.serial ? `S/N ${it.serial}` : null].filter(Boolean).join(' · ') || null,
    summary: it.short !== it.name ? it.name : null, quantity: times(it.price, it.qty) ?? undefined,
    notes: it.refunded ? [{text: `Refunded ${formatQuantity(it.refunded)}`, tone: 'warn'}] : undefined,
    link: it.link};
}

export function Record({v, e, pane}) {
  const r = e.answer.record, text = e.answer.text ?? '';
  pane.kind.current = {copyText: () => text};
  const about = [r.merchant, r.date ? dateText(r.date) : null, r.number ? `#${r.number}` : null].filter(Boolean);
  const shipping = [r.tracking.length ? {label: r.tracking.length > 1 ? 'Tracking numbers' : 'Tracking', value: r.tracking.join(', ')} : null,
    r.option ? {label: 'Method', value: r.option} : null, r.to ? {label: 'Shipped to', value: r.to} : null].filter(Boolean);
  const paying = [r.payment ? {label: 'Payment', value: cardText(r.payment)} : null, r.due ? {label: 'Due', value: dateText(r.due)} : null,
    r.account ? {label: 'Account', value: r.account} : null].filter(Boolean);
  const items = r.items.map(itemRow);
  return html`
    <div class="dv-scroll dv-recordscroll" onScroll=${ev => { e.view.scrollTop = ev.currentTarget.scrollTop; }}>
      <article class="dv-record">
        <header class="dv-rhead">
          <div class="dv-rabout">${about.join(' · ')}${r.status ? html`<span class=${`dp-note ${statusTone(r.status)}`}>${r.status}</span>` : null}</div>
          ${r.link ? html`<${Link} v=${v} url=${r.link}>${r.type === 'order' || r.type === 'digital-order' ? 'Order page' : 'Its page'}<//>` : null}
        </header>
        ${items.length ? html`<section class="dv-rsec" aria-label="Items"><div class="dk-label">${items.length === 1 ? 'Item' : `Items · ${items.length}`}</div>
          <${RowList} items=${items} onOpen=${it => it.link ? v.openUrl(it.link) : null} /></section>` : null}
        ${r.totals.length ? html`<section class="dv-rsec dv-rtotals" aria-label="Amounts"><div class="dk-label">Amounts</div>
          <${Facts} facts=${r.totals.map(t => ({label: t.label, ...(t.amount ? {quantity: t.amount} : {value: t.text})}))} /></section>` : null}
        ${shipping.length ? html`<section class="dv-rsec" aria-label="Shipping"><div class="dk-label">Shipping</div><${Facts} facts=${shipping} /></section>` : null}
        ${paying.length ? html`<section class="dv-rsec" aria-label="Payment"><div class="dk-label">Payment</div><${Facts} facts=${paying} /></section>` : null}
        ${text ? html`<details class="dv-rsec dv-rsource"><summary class="dv-summary"><${Glyph} name="next" size=${14} />Source text</summary><pre>${text}</pre></details>` : null}
      </article>
    </div>`;
}
