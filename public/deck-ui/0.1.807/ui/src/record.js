// A record (palette SPEC.md, *Kinds*: `record`): a typed document that is no file of its own (an order, a receipt, a bill, a
// statement or an invoice bridge read from a source's rows or a mail's text; model hasFile false) read from what bridge already answers for it (bridge.doc:
// its type, fields and facts), no DOM and no model call. The viewer shows it in place of the text dump; Details then shows only what
// the record does not (`used`, `usedFields`).
import {moneyText} from './quantity.js';
import {hasFile} from '../../palette/model.mjs';

export const RECORD_TYPES = ['order', 'digital-order', 'receipt', 'bill', 'statement', 'invoice'];
/** Records named by what was bought (an order's first item); the others keep their own title (`Corner Hardware receipt`). */
const ORDERS = ['order', 'digital-order'];
/** Amount facts of the record's own subject, in the order a receipt prints them. */
const AMOUNTS = ['subtotal', 'shipping', 'tax', 'discount', 'total', 'amount', 'paid', 'refunded', 'previous-balance', 'new-balance', 'balance',
  'minimum-due', 'amount-due'];
const NUMBERS = ['order-number', 'invoice-number', 'receipt-number', 'statement-number', 'bill-number', 'confirmation-number'];
const OWN = [...NUMBERS, ...AMOUNTS, 'order-link', 'tracking-number', 'due-date', 'account-number'];
/** An item's facts: a subject holding one of these is a line of the record. */
const ITEM = ['quantity', 'price', 'product-link', 'shipment-status', 'ship-date', 'serial-number', 'refunded'];
const FIELDS = {merchant: ['Merchant', 'Store', 'Vendor', 'Website', 'Service'], status: ['Status'], payment: ['Payment', 'Payment method', 'Card'],
  number: ['Order ID', 'Order number', 'Invoice', 'Invoice number', 'Receipt number'], option: ['Shipping option', 'Shipping'], to: ['Shipped to', 'Ship to']};
const LABELS = {'previous-balance': 'Previous balance', 'new-balance': 'New balance', 'minimum-due': 'Minimum due', 'amount-due': 'Amount due'};
const label = k => LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
/** A subject that is the record itself (`Amazon order 112-…`, `Invoice #12`), not who it is from. */
const RECORDISH = /\b(order|receipt|invoice|statement|bill)\b|#\s*\d|\d{3}-\d{7}-\d{7}/i;

/** A long product or document name cut by rule: up to its first comma or parenthesis (`Cuckoo Multi Pressure Cooker, CMC-…, 5QT` →
 *  `Cuckoo Multi Pressure Cooker`), `max` characters at most. */
export function shortName(name, max = 60) {
  const all = String(name ?? '').trim().replace(/\s+/g, ' ');
  const cut = all.split(/\s*[,(]/)[0].trim();
  const out = cut.length >= 3 ? cut : all;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** A fact the record shows (`record.used`): by its id, else by what it says (the pane may hold its own copy of the document). */
export const factKey = f => f.id != null ? `#${f.id}` : `${f.subject}\u0000${f.key}\u0000${f.value}`;
export const shows = (record, f) => !!record?.used.has(factKey(f));

/** The record of bridge's document `doc` (bridge.doc's answer), or null when it is none: not one of RECORD_TYPES, or nothing to show
 *  as a record (no item and no amount), or a file (its own pages show). The title: the owner's, else an order's first
 *  item's short name, else its own, short.
 *  {type, title, merchant, number, link, date, status, items: [{name, short, qty, price, link,
 *  status, shipped, serial, refunded}], totals: [{key, label, amount, text}], tracking, option, to, payment, due, account,
 *  used: the facts shown (factKey; `shows`), usedFields: Set of field names shown}. */
export function recordOf(doc) {
  if (!doc || !RECORD_TYPES.includes(doc.type) || hasFile(doc)) return null;
  const facts = (doc.facts ?? []).filter(f => f && f.subject != null), fields = doc.fields ?? [];
  const used = new Set(), usedFields = new Set();
  const field = names => {
    for (const n of names) {
      const f = fields.find(x => String(x.name).toLowerCase() === n.toLowerCase() && x.value);
      if (f) { usedFields.add(f.name); return f.value; }
    }
    return null;
  };
  const subjects = [...new Set(facts.map(f => f.subject))];
  const of = s => facts.filter(f => f.subject === s);
  const own = subjects.find(s => of(s).some(f => OWN.includes(f.key))) ?? null;
  const take = (list, key) => { const f = list.find(x => x.key === key); if (f) used.add(factKey(f)); return f?.value ?? null; };
  const takeAll = (list, key) => list.filter(x => x.key === key).map(f => (used.add(factKey(f)), f.value));

  const items = subjects.filter(s => s !== own && of(s).some(f => ITEM.includes(f.key))).map(name => {
    const fs = of(name), qty = Number(take(fs, 'quantity'));
    return {name, short: shortName(name), qty: Number.isFinite(qty) && qty > 0 ? qty : null, price: moneyText(take(fs, 'price')), link: take(fs, 'product-link'),
      status: take(fs, 'shipment-status'), shipped: take(fs, 'ship-date'), serial: take(fs, 'serial-number'), refunded: moneyText(take(fs, 'refunded'))};
  });
  const mine = own ? of(own) : [];
  const totals = AMOUNTS.flatMap(key => mine.filter(f => f.key === key).map(f => (used.add(factKey(f)), {key, label: label(key), amount: moneyText(f.value), text: f.value})));
  if (!items.length && !totals.length) return null;
  // its number: the fact, and the field saying the same is the same thing shown once
  const number = NUMBERS.map(k => take(mine, k)).find(Boolean) ?? null;
  const fieldNumber = field(FIELDS.number);
  return {
    type: doc.type,
    title: doc.edited?.title != null ? doc.title : !items.length || !ORDERS.includes(doc.type) ? shortName(doc.title, 80) : `${items[0].short}${items.length > 1 ? ` +${items.length - 1} more` : ''}`,
    merchant: field(FIELDS.merchant) ?? (own && !RECORDISH.test(own) ? own : null),
    number: number ?? fieldNumber,
    link: take(mine, 'order-link'),
    date: doc.date ?? null,
    status: field(FIELDS.status),
    items, totals,
    tracking: takeAll(mine, 'tracking-number'),
    option: field(FIELDS.option),
    to: field(FIELDS.to),
    payment: field(FIELDS.payment),
    due: take(mine, 'due-date'),
    account: take(mine, 'account-number'),
    used, usedFields,
  };
}
