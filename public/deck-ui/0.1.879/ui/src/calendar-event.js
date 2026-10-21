// A calendar event read as a document (bridge's calendar source: type `calendar-event`, read by the source, no facts), no DOM: its
// start and end, place, calendar and notes from what bridge already answers for it (bridge.doc's summary `start · end · place` and
// sourceId `<account>/<calendar id>/…`; the text read: title, start, end, place, description, attendees), never a model call. The
// viewer shows it as an event (view/viewer/card.js Event), not the text dump.

export const CALENDAR_TYPES = ['calendar-event'];
const MOMENT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^(.*?)\s*<?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?$/;

/** A calendar's name from a calendar document's sourceId: the account for its primary calendar, Google's own calendars by name
 *  (Birthdays, Holidays); null for any other (its id is no name). */
export function calendarName(sourceId) {
  const [account, raw] = String(sourceId ?? '').split('/');
  if (!account || !raw) return null;
  let id;
  try { id = decodeURIComponent(raw); } catch { return null; }
  if (id === 'primary' || id === account) return account;
  if (/#contacts@group\.v\.calendar\.google\.com$/.test(id)) return 'Birthdays';
  if (/#holiday@group\.v\.calendar\.google\.com$/.test(id)) return 'Holidays';
  return null;
}

/** The event of calendar document `doc` (bridge.doc's answer, or a find result's document) with its `text` (bridge's pages
 *  answer), or null when it is none: {start, end, allDay, place, calendar, notes: [line], attendees: [{name, email}]}. */
export function calendarEventOf(doc, text = '') {
  if (!doc || !CALENDAR_TYPES.includes(doc.type)) return null;
  const parts = String(doc.summary ?? '').split(' · ').map(s => s.trim());
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const moments = lines.filter(l => MOMENT.test(l));
  const [start, end] = MOMENT.test(parts[0] ?? '') ? [parts[0], MOMENT.test(parts[1] ?? '') ? parts[1] : null] : [moments[0] ?? doc.date ?? null, moments[1] ?? null];
  if (!start) return null;
  const place = MOMENT.test(parts[0] ?? '') ? parts.slice(end ? 2 : 1).join(' · ') : '';
  const said = new Set([doc.title, start, end, place].filter(Boolean).map(s => String(s).trim()));
  const rest = lines.filter(l => !said.has(l) && !MOMENT.test(l));
  const attendees = [], notes = [];
  for (const l of rest) {
    const m = EMAIL.exec(l);
    if (m) attendees.push({name: m[1].trim() || null, email: m[2]}); else notes.push(l);
  }
  return {start, end, allDay: DAY.test(start), place, calendar: calendarName(doc.sourceId), notes, attendees};
}
