// A thing's page is its hub (contract/things.md *Hub*), no DOM: what bridge's thing detail joins (its House devices live, its
// usage sessions and the Health practice they log, Habitat's rules on it, its purchase, warranty and papers) as the words, rows and
// links the page shows, and the usage pager (`bridge.things.usage`, bridge's opaque cursor). Bridge owns every join; Deck formats.
import {dateText, isoDay, joinText, plural, relativeDay, timeText} from './format.js';
import {amountText} from './quantity.js';
import {describeFailure} from './failure.js';

/** A moment as the hub says it: `Today 7:12 AM`, `Yesterday 9:03 PM`, `Monday 6:40 AM`, then `Sat, Oct 3 7:10 AM`. */
export function whenText(at, now = new Date()) {
  const time = timeText(at);
  return time ? `${relativeDay(at, now)} ${time}` : '';
}
const lower = text => text.replace(/^(Today|Yesterday|Tomorrow) /, (_, d) => `${d.toLowerCase()} `);
/** A session's length: `12 min`, `1 h 5 min`; running (no end): `running`. */
export function minutesText(session) {
  if (!session?.end) return 'running';
  const m = Math.max(0, Math.round(Number(session.minutes) || 0));
  return m < 60 ? `${m} min` : joinText([`${Math.floor(m / 60)} h`, m % 60 ? `${m % 60} min` : null], ' ');
}

/** The usage line: `Used 18 times in 30 days · last today 7:12 AM, 12 min`; none in 30 days: `Not used in 30 days · last …`. */
export function usageSummary(usage, now = new Date()) {
  if (!usage) return null;
  const n = Number(usage.count30d) || 0;
  const count = n ? `Used ${n === 1 ? 'once' : `${plural(n, 'time')}`} in 30 days` : 'Not used in 30 days';
  const last = usage.last?.start ? `last ${lower(whenText(usage.last.start, now))}, ${minutesText(usage.last)}` : null;
  return joinText([count, last]);
}

/** The Health line: `Red light therapy · 18 sessions in 30 days`. */
export const healthLine = health => health?.practice ? joinText([health.practice, `${plural(Number(health.count30d) || 0, 'session')} in 30 days`]) : null;

/** A card's lines for the thing's page (a thing opened in place): its usage line, its Health line. */
export const hubLines = (thing, now = new Date()) => [usageSummary(thing?.usage, now), healthLine(thing?.health)].filter(Boolean);

const DAY_MS = 864e5;
/** The 12-week strip (`usage.days`, house-local days with a session): `weeks` columns, oldest first, of seven days Sunday first, the
 *  last column this week; each day {day, used, future}. `count` the days used in it. */
export function usageWeeks(days = [], now = new Date(), weeks = 12) {
  const used = new Set(days), today = isoDay(now);
  const at = Date.parse(`${today}T12:00:00Z`), weekday = new Date(at).getUTCDay();
  const first = at - (weekday + (weeks - 1) * 7) * DAY_MS;
  const columns = Array.from({length: weeks}, (_, w) => Array.from({length: 7}, (_, d) => {
    const day = new Date(first + (w * 7 + d) * DAY_MS).toISOString().slice(0, 10);
    return {day, used: used.has(day), future: day > today};
  }));
  return {columns, count: columns.flat().filter(d => d.used).length};
}

const SOURCE = {power: 'Power reading', state: 'Switched on'};
/** A session as a row: when, how long and what told (the practice it is, its power reading, its switch). */
export const sessionLine = s => joinText([minutesText(s), s.source === 'practice' ? s.practice?.name ?? 'Practice' : SOURCE[s.source] ?? null]);
/** Whether a session is in Health: `logged` (its `practice.url` the day in Allos), `not` (a practice Health has not taken), or null. */
export const healthOf = s => !s?.practice ? null : s.practice.logged && s.practice.url ? 'logged' : s.practice.logged ? null : 'not';

/** A rule's last run and how it is: `Fired today 7:24 AM · OK · Healthy`. */
export function ruleLine(rule, now = new Date()) {
  const o = rule.lastOutcome, outcome = o ? o.ok ? (o.shadow ? 'OK in shadow' : 'OK') : joinText([o.shadow ? 'Failed in shadow' : 'Failed', o.error], ': ') : null;
  return joinText([rule.lastFired ? `Fired ${lower(whenText(rule.lastFired, now))}` : 'Never fired', outcome,
    rule.healthy === false ? 'Unhealthy' : rule.healthy ? 'Healthy' : null]);
}
/** House admin's rule (view/house.js Admin: the hash names the rule it shows first). */
export const ruleHref = rule => `/house/rules#${encodeURIComponent(rule.id)}`;
/** Money's transaction (contract/money.md: `/transactions?txn=ID` under its base). */
export const chargeHref = charge => `/money/transactions?txn=${encodeURIComponent(String(charge.id))}`;
/** A charge as its line: `Charged $1,299.00 · Mar 2, 2026 · Example card` (bridge's ledger amounts: money out negative). */
export const chargeLine = c => joinText([`Charged ${amountText(Number.isFinite(c.amount) ? {...c, amount: Math.abs(c.amount)} : c.amount) ?? ''}`.trim(), dateText(c.date), c.account]);

/** The purchase's and warranty's facts, only what is known. */
export function purchaseFacts(purchase, warranty) {
  return [
    {label: 'Merchant', value: purchase?.store}, {label: 'Bought on', value: purchase?.date ? dateText(purchase.date) : null},
    {label: 'Price', value: amountText(purchase?.price)}, {label: 'Order', value: purchase?.orderNumber},
    {label: 'Warranty ends', value: warranty?.expires ? dateText(warranty.expires) : null}, {label: 'Warranty terms', value: warranty?.terms},
  ].filter(f => f.value != null && f.value !== '');
}

/** Every paper the thing has, once each: its order's document, then its documents, manuals and the documents linked to it
 *  (ThingLinks' `document` links, `ref` its document), newest first where dated; `what` says which. `shown`: ids a section above
 *  already shows (the page's Purchase shows its order's document), left out here. */
export function thingPapers(thing, links = [], {shown = []} = {}) {
  const seen = new Set(), out = [], skip = new Set(shown.map(Number));
  const add = (d, what) => {
    const id = Number(d?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    // the same paper again (its order's email is also among its documents): what the first lacked, its date
    if (seen.has(id)) { const had = out.find(x => x.id === id); had.date ??= d.date ?? null; had.title ??= d.title; return; }
    seen.add(id); out.push({...d, id, what});
  };
  add(thing?.purchase?.document, 'Order');
  for (const d of thing?.documents ?? []) add(d, null);
  for (const d of thing?.manuals ?? []) add(d, 'Manual');
  for (const l of links) if (l.kind === 'document') add({id: l.ref?.id ?? l.id, title: l.title, date: l.date ?? null}, 'Linked');
  return out.filter(d => !skip.has(d.id)).map((d, i) => [d, i]).sort(([a, i], [b, j]) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || i - j).map(([d]) => d);
}

/** Habitat's entities (view/house.js's shape) and their states from bridge's devices, for the House controls of a thing's page. */
export function deviceEntities(devices = []) {
  const entities = [], states = [], seen = new Set();
  for (const d of devices) for (const e of d.entities ?? []) {
    if (!e?.id || seen.has(e.id)) continue;
    seen.add(e.id);
    const domain = e.domain ?? String(e.id).split('.')[0], attributes = e.unit ? {unit_of_measurement: e.unit} : {};
    entities.push({id: e.id, domain, name: e.name ?? d.name ?? e.id, attributes, device: d.id});
    if (e.state != null) states.push({entity_id: e.id, state: e.state, attributes});
  }
  return {entities, states};
}

/** Whether a part of the thing bridge could not read (`unavailable`: `habitat`, Habitat did not answer: no devices, alerts, usage or
 *  rules; `usage` or `rules` alone: only that part). */
export const unavailable = (thing, part = 'habitat') => Array.isArray(thing?.unavailable) && thing.unavailable.includes(part);
export const houseUnavailable = thing => unavailable(thing, 'habitat');

/** The thing's sessions past the first page: `more()` asks bridge for the next (its `next` cursor) and appends; the first page is
 *  the thing detail's. `all` the page shows every session read so far, not the newest few. */
export function createUsage(host, id, usage) {
  let stopped = false, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const model = {
    sessions: usage?.sessions ?? [], next: usage?.next ?? null,
    loading: false, error: null, all: false,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    showAll() { model.all = true; changed(); },
    async more() {
      if (stopped || model.loading || !model.next) return;
      request = new AbortController();
      model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.things.usage', {query: {id, cursor: model.next}}, {signal: request.signal});
        if (stopped) return;
        const known = new Set(model.sessions.map(s => s.start));
        model.sessions = [...model.sessions, ...(answer?.sessions ?? []).filter(s => !known.has(s.start))];
        model.next = answer?.next ?? null;
      } catch (e) { if (!stopped) model.error = describeFailure('bridge', e); }
      if (!stopped) { model.loading = false; changed(); }
    },
    stop() { stopped = true; request?.abort(); subscribers.clear(); },
  };
  return model;
}
