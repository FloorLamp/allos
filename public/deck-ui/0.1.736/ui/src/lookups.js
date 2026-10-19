import {formatQuantity} from './quantity.js';
// Read-only lookups use the backends' stored facts and ledger aggregates, never Ask.
// Keep the money grammar explicit: an ISO month is unambiguous on every device.
export function spendingQuery(q) {
  const m = q.trim().match(/^(?:how much (?:did I |have I )?(?:spend|spent)|spent|spending) (?:at|on) (.+?) in (\d{4})-(0[1-9]|1[0-2])\??$/i);
  if (!m) return null;
  const [, merchant, year, month] = m;
  const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return {merchant, period: `${year}-${month}`, query: {q: merchant, from: `${year}-${month}-01`, to: `${year}-${month}-${last}`, kind: 'spending', limit: 1}};
}

/** Deck's find rules for flightplan (palette SPEC.md, *Flightplan in Find*): what a question asks of flightplan's views, answered with
 *  no bridge or model call (flightplan.js `planAnswer`); null: bridge's find as before. `lists` flightplan's [{slug, title}].
 *  → {kind: today | week | needs-you | open | projects} | {kind: list, slug, title} | {kind: epic, words}. */
export function planQuery(q, lists = []) {
  const t = String(q).toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim();
  if (/^(?:status|projects|projects? status|how are (?:the )?projects going)$/.test(t)) return {kind: 'projects'};
  if (/^(?:what(?:'?s| is) )?(?:due )?today$/.test(t)) return {kind: 'today'};
  if (/^(?:what(?:'?s| is) due|due|upcoming|(?:what(?:'?s| is) )?(?:due )?this week)$/.test(t)) return {kind: 'week'};
  if (/^(?:what )?needs (?:you|me)$/.test(t)) return {kind: 'needs-you'};
  if (/^(?:my open|my|open) todos$/.test(t)) return {kind: 'open'};
  const name = t.replace(/ list$/, '').replace(/-/g, ' '), list = name && lists.find(l => [l.slug, l.title].some(n => n && String(n).toLowerCase().replace(/-/g, ' ') === name));
  if (list) return {kind: 'list', slug: list.slug, title: list.title || list.slug};
  const epic = /^(.+?) (?:status|progress)$/.exec(t);
  return epic ? {kind: 'epic', words: epic[1]} : null;
}

export const factQuery = q => /\b(expir(?:y|ation|es?|ing)|renewal|(?:passport|policy|member|membership|serial) (?:number|#)|account (?:number|balance)|routing number|vin|mileage|odometer|license plate|licence plate|date of birth|birth date|birthday|phone number|email address)\b/i.test(q);

export async function spendingResults(host, lookup, options) {
  let resolution;
  try { resolution = await host.call('purser.merchants.resolve', {query: {name: lookup.merchant}}, options); }
  catch (e) { if (e.code !== 'unsupported') throw e; }
  const exact = resolution?.status === 'resolved' && resolution.merchants?.length === 1 &&
    Number.isSafeInteger(resolution.merchants[0].id) && resolution.merchants[0].id > 0;
  if (resolution?.status === 'resolved' && !exact) throw new Error('Invalid merchant resolution');
  const query = {...lookup.query};
  if (exact) { delete query.q; query.merchant = resolution.merchants[0].id; }
  const r = await host.call('purser.txns', {query}, options);
  if (!Number.isSafeInteger(r?.sum_cents) || !Number.isSafeInteger(r?.total) || r.total < 0) throw new Error('Invalid spending total');
  const amount = formatQuantity({value: -r.sum_cents / 100, format: 'currency'});
  return {results: [{kind: 'answer', title: `${exact ? lookup.merchant : `Matches for ${lookup.merchant}`} · ${amount} spent in ${lookup.period}`, value: -r.sum_cents,
    subtitle: exact ? `Purser · ${r.total} transactions · exact merchant total` : `Purser · ${r.total} matching transactions · description, notes, category, account or merchant matches`, state: r.total ? 'current' : 'unknown'}]};
}

export async function lookupAnswer(host, q) {
  const spending = spendingQuery(q);
  if (!spending && !factQuery(q)) return null;
  const r = spending ? await spendingResults(host, spending) : await host.call('bridge.find', {q, limit: 20});
  const identifiers = /\b(number|vin|plate)\b|#/i.test(q);
  const rows = (r?.results ?? []).filter(r => ['answer', 'none'].includes(r.kind) || identifiers && r.kind === 'identifier');
  const contact = /\bphone number\b/i.test(q) ? /phone|mobile|telephone/i : /\bemail address\b/i.test(q) ? /e-?mail/i : null;
  if (contact) for (const row of r?.results ?? []) {
    if (row.kind !== 'person') continue;
    for (const id of row.person?.ids ?? []) if (contact.test(id.title) && id.value) {
      rows.push({kind: 'identifier', title: `${row.person.name} · ${id.title}`, value: id.value, document: row.document});
    }
  }
  const citations = [...new Map(rows.filter(r => r.document).map(r => [r.document.id, r.document])).values()];
  return {answer: rows.length ? rows.map(r => [r.title, r.kind === 'identifier' ? r.value : null, r.subtitle].filter(Boolean).join(' · ')).join('\n') : 'No stored fact found. Try the subject’s name and the field you need.', citations};
}
