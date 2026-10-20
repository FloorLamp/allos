// Text the views show for dates, ranges, times, relative times, counts, names and field labels: one style everywhere, no DOM.
// Numbers, money, units and durations: quantity.js. contract/foundation.md, *Format*.
//   a day 'YYYY-MM-DD' is a calendar day (no zone shift); 'YYYY-MM' a month, 'YYYY' a year; anything else (ISO time, ms, Date) a
//   moment, read in `timeZone` (default the device's).
import {formatQuantity} from './quantity.js';

// Shared zone math uses the same formatting boundary as the views.
export const DateTimeFormatter = Intl.DateTimeFormat;

const LOCALE = 'en-US';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const pad = n => String(n).padStart(2, '0');

/** {y, m, d (null for a month or year), time: the moment or null} of anything a view holds; null when it is no date. */
function partsOf(at, timeZone) {
  if (at == null || at === '') return null;
  const m = typeof at === 'string' ? DAY.exec(at.trim()) : null;
  if (m) return {y: Number(m[1]), m: m[2] ? Number(m[2]) : null, d: m[3] ? Number(m[3]) : null, time: null};
  const t = at instanceof Date ? at : new Date(typeof at === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(at) ? at.replace(' ', 'T') : at);
  if (Number.isNaN(t.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat(LOCALE, {timeZone, year: 'numeric', month: 'numeric', day: 'numeric'}).formatToParts(t).map(x => [x.type, x.value]));
  return {y: Number(p.year), m: Number(p.month), d: Number(p.day), time: t};
}
const utcDay = p => Date.UTC(p.y, p.m - 1, p.d);
const weekdayOf = p => WEEKDAYS[new Date(utcDay(p)).getUTCDay()];
const yearOf = now => now == null ? null : partsOf(now)?.y;

/** The 'YYYY-MM-DD' of a day or moment (in `timeZone`); '' when it is no date. */
export function isoDay(at, {timeZone} = {}) {
  const p = partsOf(at, timeZone);
  return p?.d ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : '';
}

/** A day's weekday: `Thu` (`long`: `Thursday`). */
export function weekdayText(at, {timeZone, long = false} = {}) {
  const p = partsOf(at, timeZone);
  return p?.d ? weekdayOf(p).slice(0, long ? undefined : 3) : '';
}

/** A day: `Oct 15, 2026`; `Oct 15` when `now` is the same year; `weekday` adds `Thu, `. A month `Oct 2026` (`Oct` that year), a year `2026`.
 *  Not a date: the text as given. */
export function dateText(at, {now = null, weekday = false, timeZone} = {}) {
  const p = partsOf(at, timeZone);
  if (!p) return at == null ? '' : String(at);
  if (!p.m) return String(p.y);
  if (!p.d) return now != null && yearOf(now) === p.y ? MONTHS[p.m - 1] : `${MONTHS[p.m - 1]} ${p.y}`;
  const day = `${weekday ? `${weekdayOf(p).slice(0, 3)}, ` : ''}${MONTHS[p.m - 1]} ${p.d}`;
  return now != null && yearOf(now) === p.y ? day : `${day}, ${p.y}`;
}

/** Two days as one range, the shared parts once: `Aug 1–5, 2025`, `Jul 31–Aug 5, 2025`, `Dec 30, 2025–Jan 2, 2026`; months
 *  `Jul–Sep 2025`; one day or a missing end: that day. `now` the same year drops the year. */
export function dateRange(from, to, {now = null, timeZone} = {}) {
  const a = partsOf(from, timeZone), b = partsOf(to, timeZone);
  if (!a) return b ? dateText(to, {now, timeZone}) : '';
  if (!b || (a.y === b.y && a.m === b.m && a.d === b.d)) return dateText(from, {now, timeZone});
  const year = y => now != null && yearOf(now) === a.y && a.y === b.y ? '' : `, ${y}`;
  if (!a.d || !b.d) {
    const label = p => p.m ? `${MONTHS[p.m - 1]} ${p.y}` : String(p.y);
    return a.m && b.m && a.y === b.y ? `${MONTHS[a.m - 1]}–${MONTHS[b.m - 1]} ${b.y}` : `${label(a)}–${label(b)}`;
  }
  if (a.y !== b.y) return `${MONTHS[a.m - 1]} ${a.d}, ${a.y}–${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
  if (a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d}–${b.d}${year(a.y)}`;
  return `${MONTHS[a.m - 1]} ${a.d}–${MONTHS[b.m - 1]} ${b.d}${year(a.y)}`;
}

/** A moment's time: `3:40 PM`; `seconds` `3:40:12 PM`; `compact` drops `:00` (`9 AM`); `zone` adds the zone (`EDT`). */
export function timeText(at, {timeZone, seconds = false, compact = false, zone = false} = {}) {
  const t = partsOf(at, timeZone)?.time;
  if (!t) return '';
  const text = t.toLocaleTimeString(LOCALE, {timeZone, hour: 'numeric', minute: '2-digit', ...(seconds ? {second: '2-digit'} : {}), ...(zone ? {timeZoneName: 'short'} : {})});
  return compact ? text.replace(':00 ', ' ') : text;
}

/** A wall clock's time, 24-hour with two digits: `06:33`, `18:40` (the camera wall's band, as its HA dashboard showed it). */
export function clockText(at, {timeZone} = {}) {
  const t = partsOf(at, timeZone)?.time;
  if (!t) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat(LOCALE, {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(t).map(x => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}

/** A day as the wall's band shows it: weekday and month/day, `Tue 10/20`. */
export function shortDayText(at, {timeZone} = {}) {
  const p = partsOf(at, timeZone);
  return p?.d ? `${weekdayOf(p).slice(0, 3)} ${p.m}/${p.d}` : '';
}

/** A moment's day and time: `Oct 15, 2026, 3:40 PM` (`now`, `weekday`, `timeZone`, `seconds`, `zone` as above). */
export function dateTimeText(at, {now = null, weekday = false, timeZone, seconds = false, zone = false} = {}) {
  const p = partsOf(at, timeZone);
  if (!p?.time) return p ? dateText(at, {now, weekday}) : '';
  return `${dateText(isoDay(at, {timeZone}), {now, weekday})}, ${timeText(at, {timeZone, seconds, zone})}`;
}

/** A day from `today` (both days or moments): Today, Tomorrow, Yesterday, a weekday within the coming week, else `Sat, Oct 24`
 *  (this year) or `Oct 24, 2025`. */
export function relativeDay(day, today = new Date(), {timeZone} = {}) {
  const p = partsOf(day, timeZone), q = partsOf(today, timeZone);
  if (!p?.d || !q?.d) return dateText(day);
  const n = Math.round((utcDay(p) - utcDay(q)) / 864e5);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return weekdayOf(p);
  return dateText(isoDay(day, {timeZone}), {now: isoDay(today, {timeZone}), weekday: p.y === q.y});
}

/** A date section for a day or moment: {key: 'YYYY-MM-DD', label: relativeDay}. `now` a Date. */
export function dateSection(at, now = new Date()) {
  const key = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : isoDay(at);
  return {key, label: relativeDay(key, now)};
}

/** A list's when (conversations, mail): the time today, Yesterday, the weekday this week, then the day. */
export function listWhen(at, now = new Date()) {
  const p = partsOf(at), q = partsOf(now);
  if (!p?.time || !q) return '';
  const ago = Math.round((utcDay(q) - utcDay(p)) / 864e5);
  if (ago === 0) return timeText(at);
  if (ago === 1) return 'Yesterday';
  if (ago > 1 && ago < 7) return weekdayOf(p);
  return dateText(isoDay(at), {now});
}

/** Links in a line as their site, so a preview reads as words: `https://a.co/d/0bCk` → `a.co/…`, `www.example.com` → `example.com`,
 *  a bare `i.cvs.com/cziZ` → `i.cvs.com/…`; `mailto:` and the rest of the text as given. */
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"]*/gi;
export const urlsText = text => String(text ?? '').replace(LINK, link => {
  const trail = /[.,;:!?)\]]+$/.exec(link)?.[0] ?? '', url = link.slice(0, link.length - trail.length);
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#]+)(.*)$/i.exec(url);
  return m ? `${m[1].toLowerCase()}${m[2].replace(/^\/$/, '') ? '/…' : ''}${trail}` : link;
});

/** A short age for trailing columns: `now`, `5 min`, `3 h` (today), `yesterday`, `Mon` (this week), `Oct 2`. */
export function age(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at), mins = (now - t) / 60000;
  if (!Number.isFinite(mins) || mins < 1) return 'now';
  if (mins < 60) return `${Math.floor(mins)} min`;
  const days = Math.round((utcDay(partsOf(now)) - utcDay(partsOf(t))) / 864e5);
  if (days === 0) return `${Math.floor(mins / 60)} h`;
  if (days === 1) return 'yesterday';
  if (mins < 7 * 1440) return weekdayOf(partsOf(t)).slice(0, 3);
  return dateText(isoDay(t), {now});
}

/** How long ago in words: `just now`, `5 min ago`, `3 hours ago`, `4 days ago`; from 60 days the day. */
export function ago(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at), ms = now - t;
  if (!Number.isFinite(ms)) return null;
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${plural(Math.floor(min / 60), 'hour')} ago`;
  const days = Math.floor(min / 1440);
  return days < 60 ? `${plural(days, 'day')} ago` : dateText(isoDay(t), {now});
}

/** A whole count, grouped: `1,234`. */
export const countText = n => formatQuantity({value: Number(n), precision: 0});
/** A count and its noun: `1 test`, `2 tests`, `1,201 rows`; `many` for irregular plurals (`person`, `people`). */
export const plural = (n, one, many = `${one}s`) => `${countText(n)} ${Number(n) === 1 ? one : many}`;

/** Parts of one line joined by `sep` (default ` · `), empty parts dropped: never a leading, trailing or doubled separator. */
export const joinText = (parts, sep = ' · ') => parts.flat().map(p => p == null || p === false ? '' : String(p).trim()).filter(Boolean).join(sep);

/** A person's initials for an avatar: the first letters of the first and last words of the name, a bracketed note and
 *  punctuation left out (`Sam (plumber)` → `S`, `Sam Rivera` → `SR`); `?` without a name. */
export function initials(name) {
  const words = String(name ?? '').replace(/\([^)]*\)?|\[[^\]]*\]?/g, ' ').split(/\s+/).map(w => [...w].find(c => /[\p{L}\p{N}]/u.test(c))).filter(Boolean);
  return (words.length > 1 ? words[0] + words.at(-1) : words[0] ?? '?').toUpperCase();
}

/** A raw key or state as people read it, sentence case: `serial_number`, `serial-number`, `serialNumber` → `Serial number`;
 *  `locked` → `Locked`. Existing capitals stay (`VIN`); acronyms are capitals (`national_id` → `National ID`) and a few names
 *  keep their own spelling (`drivers_licence` → `Driver's licence`, `global_entry` → `Global Entry`). */
const ACRONYMS = new Set(['id', 'us', 'usa', 'uk', 'eu', 'vin', 'ev', 'hoa', 'ssn', 'tsa', 'dmv', 'irs', 'hsa', 'fsa', 'ira', 'llc', 'pdf', 'gps', 'tv', 'hvac']);
const NAMES = {'drivers licence': 'Driver’s licence', 'drivers license': 'Driver’s license', 'driver licence': 'Driver’s licence',
  'driver license': 'Driver’s license', 'global entry': 'Global Entry', 'real id': 'REAL ID'};
export const fieldLabel = key => {
  const words = String(key ?? '').replace(/([a-z0-9])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`)
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const named = NAMES[words.toLowerCase()];
  if (named) return named;
  return words.split(' ').map(w => ACRONYMS.has(w.toLowerCase()) && w === w.toLowerCase() ? w.toUpperCase() : w).join(' ')
    .replace(/^./u, c => c.toUpperCase());
};
/** A place or jurisdiction key, every word capitalised: `new_york` → `New York`, `us` → `US`. */
export const placeLabel = key => fieldLabel(key).replace(/(^|\s)(\p{Ll})/gu, (_, s, c) => s + c.toUpperCase());

/** A person's one line wherever they are listed (People, Find, a policy's covered people): relation as people read it
 *  (`service_provider` → `Service provider`), organisation, role, then last contact and documents when known. */
export function personLine(p = {}, {history = true} = {}) {
  return joinText([p.relation ? fieldLabel(p.relation) : null, p.organisation ?? p.vendor, p.role,
    history && p.lastContact ? `Last contact ${dateText(p.lastContact)}` : null,
    history && p.documentCount ? plural(p.documentCount, 'document') : null]);
}

/** A line as people read it: its first letter a capital, the rest as given (`receipt that day` → `Receipt that day`). */
export const sentence = text => String(text ?? '').replace(/^\s*\p{Ll}/u, c => c.toUpperCase());

/** Parts of one line with repeats dropped, case aside (`child`, `child · 12 papers` → `child · 12 papers`): a part Deck adds that
 *  bridge's own line already says shows once. */
export const uniqueText = (parts, sep = ' · ') => {
  const seen = new Set();
  return joinText(parts.flatMap(p => p == null || p === false ? [] : String(p).split(sep)).filter(p => {
    const k = p.trim().toLowerCase();
    return k && !seen.has(k) && seen.add(k);
  }), sep);
};

/** Where something is, as a row names it: a venue's name, else a street address's first part; never its suite, town, state or ZIP
 *  (`Example Pediatrics, 575 Example Blvd, …` → `Example Pediatrics`; `575 Example Blvd, Suite 310 Exampleton NY 11791` → `575
 *  Example Blvd`); a meeting link by its site (`zoom.us`). */
export function placeName(place) {
  const text = String(place ?? '').trim();
  if (/^https?:\/\//i.test(text)) { try { return new URL(text).hostname.replace(/^www\./, ''); } catch { return text; } }
  const first = text.split(/\s*[,;\n]\s*/)[0] ?? '';
  return first.replace(/\s+(?:suite|ste\.?|unit|apt\.?|floor|fl\.?|room|rm\.?|#)\s*\S+.*$/i, '').replace(/\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/, '').trim() || text;
}
/** A line's part that is an address: a street number and words with a state and ZIP, or a suite after a street. */
export const isAddress = text => /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(text) || /^\d+\s+\S+.*\b(?:suite|ste\.?|unit|apt\.?)\s/i.test(text);

// A clinic's calendar title (`Established Well Child Appointment with Jordan Sample, MD for Robin Example`) as what it is and with
// whom (`Well child visit · Dr Sample`): the words that only say what kind of booking it is go, a doctor's credential becomes `Dr`.
const BOOKING = /^(.+?)\s+(?:appointment|appt\.?)\s+with\s+(.+?)(?:\s+for\s+.+)?$/i;
const BOOKING_WORDS = new Set(['established', 'new', 'returning', 'patient', 'scheduled']);
const DOCTORS = new Set(['md', 'do', 'dds', 'dmd', 'od']);
/** An event's title as a row shows it: a booking's (`<kind> appointment with <provider>[ for <person>]`) shortened to its kind and
 *  provider; any other title as given. */
export function eventTitle(title) {
  const text = String(title ?? '').trim(), m = BOOKING.exec(text);
  if (!m) return text;
  const kind = m[1].split(/\s+/).filter(w => !BOOKING_WORDS.has(w.toLowerCase())).join(' ').toLowerCase();
  const [who, ...credentials] = m[2].split(/\s*,\s*/), credential = credentials.join(', ');
  const name = who.replace(/^dr\.?\s+/i, ''), doctor = /^dr\.?\s/i.test(who) || DOCTORS.has(credential.replace(/\./g, '').toLowerCase());
  const provider = doctor ? `Dr ${name.split(/\s+/).at(-1)}` : credential ? `${name}, ${credential}` : name;
  return joinText([sentence(kind ? `${kind} visit` : 'visit'), provider]);
}
