// Due soon: bridge's dated obligations, overdue first, then the next 30 days, as shared rows.
import {dateText, isoDay} from './format.js';

/** How far ahead it looks (days). */
export const AHEAD = 30;
/** How long past its day an obligation stays (days): an expired registration or a lapsed policy until a newer term is held
 *  (bridge then drops the old date), a bill a month (bridge holds no paid mark), a past appointment not at all. Older dates are
 *  done or misread (bridge holds bills "due 2001" read from 2016 mail). */
const KEEP = {expiry: 365, renewal: 365, due: 30, appointment: 0};

const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / 864e5;

/** When, from `today` (an ISO day): `expired Jul 12`, `was due Oct 6` (overdue, the warning tone), `today`, `tomorrow`, `in 7 days`. */
export function dueWhen(o, today) {
  const n = dayNumber(o.date) - dayNumber(today);
  if (n < 0) return {text: `${o.kind === 'expiry' ? 'expired' : 'was due'} ${dateText(o.date, {now: today})}`, tone: 'warn'};
  return {text: n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`, tone: ''};
}

/** Bridge's obligations as RowList items, earliest first. A row opens its held document, else its source URL. */
export function dueSoonItems(obligations, today = isoDay(new Date())) {
  const t = dayNumber(today);
  return [...(obligations ?? [])]
    .filter(o => /^\d{4}-\d{2}-\d{2}$/.test(o?.date ?? '') && dayNumber(o.date) - t <= AHEAD && t - dayNumber(o.date) <= (KEEP[o.kind] ?? KEEP.due))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((o, i) => {
      const when = dueWhen(o, today), title = o.title;
      return {id: `due:${o.document?.id ?? 'none'}:${i}`, glyph: 'day', title, sub: o.document?.title && o.document.title !== title ? o.document.title : null, badge: when,
        tip: `${title}: ${when.text}`, docId: o.document?.id ?? null, url: o.url ?? null};
    });
}

/** Read on refresh with the obligations cap; a failed read keeps the last rows. */
export function createDueSoon(host, {today = () => isoDay(new Date())} = {}) {
  const listeners = new Set();
  let request = null, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    items: [], loaded: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() {
      if (stopped || !host.caps?.obligations) return;
      request?.abort();
      const mine = request = new AbortController(), signal = mine.signal;
      try {
        const result = await host.call('bridge.obligations', {}, {signal});
        if (stopped || signal.aborted) return;
        Object.assign(model, {items: dueSoonItems(result.obligations, today()), error: null, loaded: true});
      } catch (error) {
        if (stopped || signal.aborted) return;
        model.error = error;
      }
      notify();
    },
    stop() { stopped = true; request?.abort(); listeners.clear(); },
  };
  return model;
}
