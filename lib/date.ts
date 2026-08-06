// Timezone-aware date helpers (pure, client-safe — no DB/Node deps; Intl works in
// both Node 20 and browsers). Day boundaries follow an explicit IANA timezone that
// the caller passes in — the app's configured timezone (settings key 'timezone',
// resolved by lib/settings.getTimezone() on the server / the TimezoneProvider
// context on the client). This file never reads the DB or env; it just formats a
// concrete zone, so the "which zone" decision lives in one place.

// Intl.DateTimeFormat construction is expensive (locale-data resolution) and
// these helpers run in hot render paths (e.g. per keystroke in forms), so
// formatters are cached per locale+options. The cache stays tiny: one entry per
// distinct (locale, timezone, options) combination the app uses.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function cachedDateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(options);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    fmtCache.set(key, f);
  }
  return f;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// True only for a real calendar date in ISO YYYY-MM-DD form — rejects both bad
// formats ("12/25/2026", "2026-07") and impossible dates ("2026-13-45",
// "2026-02-30"). Shared by DateField, form auto-save gating, and server actions.
export function isRealIsoDate(v: string | null | undefined): v is string {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

// Calendar date (YYYY-MM-DD) for an instant in the given IANA timezone. en-CA
// formats as ISO order natively.
export function dateStrInTz(tz: string, d: Date = new Date()): string {
  return cachedDateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Shift a YYYY-MM-DD calendar date by N days. Anchored at UTC midnight so it never
// crosses a DST boundary — pure calendar arithmetic, independent of any timezone.
export function shiftDateStr(dateStr: string, deltaDays: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// The last `n` calendar dates ending at (and including) `anchor`, oldest first —
// the column window shared by the supplements page and the notifier's adherence.
export function lastNDates(anchor: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDateStr(anchor, -i));
  return out;
}

// Wall-clock parts (calendar date YYYY-MM-DD + HH:MM) of an instant in the given
// IANA timezone. Used to attribute an absolute timestamp to the right local day
// and minute regardless of the process TZ (production Docker runs UTC).
export function zonedDateParts(
  tz: string,
  d: Date
): { date: string; hhmm: string } {
  const parts = cachedDateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Some ICU builds emit "24" for midnight; fold it to "00".
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${hour}:${get("minute")}`,
  };
}

// An "HH:MM" wall-clock string as minutes since local midnight (0..1439) — the
// companion decoder for `zonedDateParts`'s `hhmm`, so a caller that needs the
// current profile-local minute-of-day has ONE place to get it rather than
// re-splitting the string (this had already been hand-rolled twice: privately in
// lib/sleep-summary.ts and inline in lib/food-slot.ts's foodSlotForHhmm).
// Malformed input folds to 0 rather than throwing or yielding NaN — every caller
// is a time-window comparison where NaN would silently disable the window.
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

// The minute-resolution wall-clock stamp ('YYYY-MM-DDTHH:MM') of an instant in the
// given IANA timezone — the profile-local minute an absolute timestamp is
// attributed to. This is the identity of an `hr_minutes.ts` bucket: intraday HR is
// keyed by the minute string derived here at ingest, so the stamp is
// profile-local-at-ingest and carries no zone of its own (issue #94). A later
// profile-timezone change therefore re-labels which local minute a *new* push of
// the same raw sample lands on; historical rows keep the minute they were written
// with. Pure (formats a concrete zone; reads no DB/env), so it's unit-testable in
// isolation from ingest.
export function zonedMinuteStr(tz: string, d: Date): string {
  const { date, hhmm } = zonedDateParts(tz, d);
  return `${date}T${hhmm}`;
}

// The offset (ms) of `tz` from UTC at instant `at` — i.e. (tz-local wall clock,
// read as if it were UTC) − at. Positive east of UTC. DST-correct because it reads
// the zone's actual wall clock at that specific instant. Pure (Intl only).
export function tzOffsetMs(tz: string, at: Date): number {
  const parts = cachedDateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = g("hour");
  if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
  const asUtc = Date.UTC(
    g("year"),
    g("month") - 1,
    g("day"),
    hour,
    g("minute"),
    g("second")
  );
  return asUtc - at.getTime();
}

// Settle a wall clock expressed as "the same fields read as if they were UTC" onto
// the real instant in `tz`. Two passes so a wall time near a DST transition lands on
// the offset actually in force AT that instant rather than the one in force at the
// naive guess (which is a different side of the transition). Pure (Intl only).
function settleWallUtc(naiveUtc: number, tz: string): Date {
  const first = new Date(naiveUtc - tzOffsetMs(tz, new Date(naiveUtc)));
  return new Date(naiveUtc - tzOffsetMs(tz, first));
}

// The UTC instant whose wall-clock time in `tz` is `dateStr` (YYYY-MM-DD) at
// `hhmm` (HH:MM). The inverse of zonedDateParts: turns a user-entered local time
// ("gave it at 4:02pm today") into the absolute instant to store. Pure (Intl only).
export function zonedWallTimeToUtc(
  tz: string,
  dateStr: string,
  hhmm: string
): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = dateStr.split("-").map(Number);
  return settleWallUtc(Date.UTC(y, mo - 1, d, h || 0, m || 0, 0), tz);
}

// A ZONELESS wall-clock timestamp ("2026-07-25T23:14:30.000" — the shape a vendor
// export writes when it records what the device's clock said and nothing about where
// that clock was) resolved to the absolute instant it denotes in `tz`.
//
// The same question as zonedWallTimeToUtc, asked by an INGEST path rather than a
// form, so it differs in two ways: it carries SECONDS and MILLISECONDS (a session
// boundary is stated to the second, and truncating would quietly move every stored
// window), and it REFUSES rather than guessing — an unparseable or offset-bearing
// string is not a wall clock, and returning a plausible Date for one would let a
// caller store an instant it never derived. Null on anything but a bare wall clock;
// the caller decides whether that is a skip or an already-absolute passthrough.
const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export function zonedWallIsoToUtc(tz: string, wall: string): Date | null {
  const m = WALL_CLOCK.exec(wall.trim());
  if (!m) return null;
  const n = (i: number) => (m[i] === undefined ? 0 : Number(m[i]));
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  const [mo, day, hour, min, sec] = [n(2), n(3), n(4), n(5), n(6)];
  // Range-checked because Date.UTC ROLLS OVER: month 13 silently becomes the
  // following January, which would turn a garbage string into a plausible instant a
  // year away instead of a refusal the caller can count as skipped.
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;
  const naiveUtc = Date.UTC(n(1), mo - 1, day, hour, min, sec, ms);
  if (Number.isNaN(naiveUtc)) return null;
  const inst = settleWallUtc(naiveUtc, tz);
  return Number.isNaN(inst.getTime()) ? null : inst;
}

// ---- The stored-instant convention (issue #2205) ---------------------------
//
// An INSTANT is "the absolute moment this happened/was recorded". It is a different
// question from a profile-local `date`, which is a DAY ATTRIBUTION (#94) and is NOT a
// lesser instant — `date` semantics are untouched by #2205 and must never be folded
// into these helpers.
//
// The CANONICAL serialization of an instant is `utcInstant`'s shape:
//
//     2026-07-15T20:02:03Z      UTC · second resolution · explicit `Z`
//
// Why this shape and not SQLite's own `datetime('now')` (`utcSqlString` below):
//   • the `Z` states the zone instead of leaving a reader to assume one — the
//     assumption that produced two confidently wrong cross-domain analyses;
//   • second resolution is exactly what SQLite's date functions emit, so a JS-written
//     value and a `strftime('%Y-%m-%dT%H:%M:%SZ','now')` one are byte-identical and
//     therefore sort, compare and `date()`-truncate identically;
//   • SQLite's date/time functions parse it natively, so `date()`, `julianday()` and
//     `strftime()` keep working unchanged over a converted column.
//
// Phase 1 of #2205 does NOT convert every column: it declares the convention, makes
// these two functions the ONLY way an app write path produces an instant, and moves
// the columns each migration names. `utcSqlString` remains the writer for the columns
// still on SQLite's bare shape — a column is on one convention or the other, never on
// a hand-built string. lib/__tests__/instant-writer-scan.test.ts is the ratchet.

// The canonical stored instant — UTC, second resolution, explicit `Z`. Pure.
export function utcInstant(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19) + "Z";
}

// Re-serialize an already-stored UTC datetime — EITHER convention — as the canonical
// instant. The one path for handing a bare-shaped value to a canonical-shaped
// comparison (or field), so a reader never concatenates a "Z" onto a string it has
// not actually parsed. Null on garbage/absent, like parseUtcSql. Pure.
export function toUtcInstant(s: string | null | undefined): string | null {
  const d = parseUtcSql(s);
  return d ? utcInstant(d) : null;
}

// Serialize an instant to SQLite's `datetime('now')` shape — "YYYY-MM-DD HH:MM:SS"
// in UTC, no zone suffix — so a value written from JS sorts and compares (strftime)
// identically to one written by SQLite. The LEGACY half of the convention above: the
// columns #2205 has not yet converted still store this shape, and a write to one of
// them comes from here rather than from a hand-built string. Pure.
export function utcSqlString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Parse a stored UTC datetime ("YYYY-MM-DD HH:MM:SS" or ISO with a T) back to a
// Date. SQLite datetimes carry no zone, so the value is UTC by construction; append
// "Z" so JS doesn't reinterpret it in the process-local zone. Null on garbage. Pure.
export function parseUtcSql(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T") + (/[zZ]$/.test(s) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whole days from calendar date `a` to `b` (both YYYY-MM-DD), i.e. b − a.
// UTC-anchored so it's timezone-independent and never crosses a DST boundary.
// Returns null if either date is unparseable.
export function daysBetweenDateStr(a: string, b: string): number | null {
  const ta = Date.parse(a.slice(0, 10) + "T00:00:00Z");
  const tb = Date.parse(b.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

export const WEEKDAYS_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

// Weekday (0=Sun … 6=Sat) of an instant in the given timezone.
export function weekdayInTz(tz: string, d: Date = new Date()): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
  return WEEKDAYS_SHORT.indexOf(short as (typeof WEEKDAYS_SHORT)[number]);
}

// Hour of day (0–23) of an instant in the given timezone. Some ICU builds emit
// "24" for midnight, so fold it down with % 24.
export function hourInTz(tz: string, d: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).format(d);
  return Number(h) % 24;
}

// Minute of day (0–1439) of an instant in the given timezone — the sub-hourly
// sibling of hourInTz (#2121), and the ONE derivation every scheduling comparison
// resolves "now" through. Uses the same Intl path (with the same %-24 midnight
// fold), so the two can never disagree about which hour an instant is in.
export function minuteOfDayInTz(tz: string, d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return ((get("hour") % 24) * 60 + get("minute")) % 1440;
}

// Weekday (0=Sun … 6=Sat) of a stored YYYY-MM-DD calendar date, independent of any
// timezone (UTC-anchored so the process TZ can't shift it across midnight).
export function weekdayOfDateStr(dateStr: string): number {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

// The start of the calendar week (YYYY-MM-DD) containing `dateStr`, given the
// profile's configured first day of the week (`weekStart`: 0=Sun … 6=Sat, default
// Sunday). Returns the most recent week-start day on or before `dateStr`. Pure
// calendar arithmetic (UTC-anchored, DST-immune), so it's timezone-independent and
// matches how stored dates are compared everywhere else.
export function startOfWeekStr(dateStr: string, weekStart = 0): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const back = (d.getUTCDay() - weekStart + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// The seven weekday indices (0=Sun … 6=Sat) in display order for a week that
// begins on `weekStart`. E.g. weekStart=1 (Monday) → [1,2,3,4,5,6,0]. Used to
// reorder calendar headers/grids to the profile's first day of the week.
export function weekdayOrder(weekStart = 0): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

// Build a YYYY-MM-DD string from calendar parts, with `month` 0-based (0=Jan …
// 11=Dec). Pure string assembly — the inverse of splitting an ISO date, with no
// Date/timezone involved.
export function isoDate(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

// Fixed English calendar names — the app is single-language by design (non-goal:
// no full i18n), and hardcoding these removes the runtime-locale dependence that
// an implicit-locale toLocale call leaks (the #964 bug class; finished by #1020).
// These are THE month/weekday tables: lib/format-date builds every date shape from
// them, and monthNames() below serves the calendar/heatmap consumers.
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
export const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// Month names indexed 0=Jan … 11=Dec, from the fixed English tables above (NOT the
// runtime locale — #1020 purged the toLocaleDateString implementation this used to
// have). `style` picks long ("January") or short ("Jan") — calendars use short
// names in tight layouts.
export function monthNames(style: "long" | "short" = "long"): string[] {
  return [...(style === "long" ? MONTHS_LONG : MONTHS_SHORT)];
}

// One day cell of a month-grid view. `m` is 0-based; `outside` marks the days
// that belong to the previous/next month and only fill out a partial week.
export interface CalendarCell {
  y: number;
  m: number;
  d: number;
  outside: boolean;
}

// The day cells for a month view rendered as a grid of full weeks: the month's
// own days plus the adjacent months' days padding the first and last weeks
// (flagged `outside`), so every row is a complete 7-day week. `weekStart`
// (0=Sun … 6=Sat) sets which weekday each row begins on. Pure calendar
// arithmetic — no timezone. Shared by the sidebar calendar and the date picker.
export function monthGridCells(
  year: number,
  month: number,
  weekStart = 0
): CalendarCell[] {
  const cells: CalendarCell[] = [];
  // Leading blanks before the 1st, measured from the configured week start.
  const startDow = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  for (let i = startDow - 1; i >= 0; i--) {
    const t = year * 12 + month - 1;
    cells.push({
      y: Math.floor(t / 12),
      m: ((t % 12) + 12) % 12,
      d: daysInPrev - i,
      outside: true,
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ y: year, m: month, d, outside: false });
  }
  while (cells.length % 7 !== 0) {
    const t = year * 12 + month + 1;
    const nextDay = cells.length - (startDow + daysInMonth) + 1;
    cells.push({
      y: Math.floor(t / 12),
      m: ((t % 12) + 12) % 12,
      d: nextDay,
      outside: true,
    });
  }
  return cells;
}

// Whole years from a birthdate to a reference date, both YYYY-MM-DD. Pure
// calendar arithmetic (no timezone): the birthday counts only once the
// reference month/day has reached the birth month/day. Returns null for an
// unparseable, future, or implausible (>150y) birthdate.
export function ageFromBirthdate(birthdate: string, on: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate.trim());
  const o = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on.trim());
  if (!b || !o) return null;
  const [by, bm, bd] = [+b[1], +b[2], +b[3]];
  const [oy, om, od] = [+o[1], +o[2], +o[3]];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age--;
  if (age < 0 || age > 150) return null;
  return age;
}

// Whole months from a birthdate to a reference date, both YYYY-MM-DD. Pure
// calendar arithmetic (no timezone). Used by the immunization schedule, whose
// infant milestones are expressed in months (birth, 2mo, 6mo, …). Returns null
// for an unparseable, future, or implausible (>150y) birthdate.
export function ageInMonthsFromBirthdate(
  birthdate: string,
  on: string
): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate.trim());
  const o = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on.trim());
  if (!b || !o) return null;
  const [by, bm, bd] = [+b[1], +b[2], +b[3]];
  const [oy, om, od] = [+o[1], +o[2], +o[3]];
  let months = (oy - by) * 12 + (om - bm);
  if (od < bd) months--;
  if (months < 0 || months > 150 * 12) return null;
  return months;
}

// FRACTIONAL age in months (issue #405), for a continuous growth-chart x-axis.
// ageInMonthsFromBirthdate returns WHOLE months, so several measurements inside one
// calendar month collapse to the same age — a growth trajectory keyed by it drops
// all but the last (and quantizes day-1 vs day-30 onto one pixel). This returns
// months as a real number (elapsed days ÷ 30.4375, the mean Gregorian month) so
// each measurement plots at its true age. Null for unparseable/future/implausible
// dates (mirrors ageInMonthsFromBirthdate's guards). Whole-month math still drives
// percentile SCORING; this drives only plotting/keying.
export function ageInMonthsExact(birthdate: string, on: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate.trim());
  const o = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on.trim());
  if (!b || !o) return null;
  const days =
    (Date.UTC(+o[1], +o[2] - 1, +o[3]) - Date.UTC(+b[1], +b[2] - 1, +b[3])) /
    86_400_000;
  const months = days / 30.4375;
  if (months < 0 || months > 150 * 12) return null;
  return months;
}

// The canonical age-in-months POLICY (issue #310), as a pure function so every
// surface resolves age identically: prefer the birthdate (real calendar month
// math via ageInMonthsFromBirthdate) — the birthdate ALWAYS wins, even if a bare
// stored age is also present — else fall back to the stored whole-year age × 12,
// else null (age unknown). The DB-reading wrapper is profileAgeMonths() in
// lib/settings.ts; the immunization pages keep their own birthdate/storedAge
// reads (they display those intermediates) and share only this month-resolution
// core.
export function ageMonthsFrom(
  birthdate: string | null,
  storedAge: number | null,
  on: string
): number | null {
  if (birthdate) return ageInMonthsFromBirthdate(birthdate, on);
  return storedAge != null ? storedAge * 12 : null;
}
