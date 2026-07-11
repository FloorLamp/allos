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

// Whole days from calendar date `a` to `b` (both YYYY-MM-DD), i.e. b − a.
// UTC-anchored so it's timezone-independent and never crosses a DST boundary.
// Returns null if either date is unparseable.
export function daysBetweenDateStr(a: string, b: string): number | null {
  const ta = Date.parse(a.slice(0, 10) + "T00:00:00Z");
  const tb = Date.parse(b.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Weekday (0=Sun … 6=Sat) of an instant in the given timezone.
export function weekdayInTz(tz: string, d: Date = new Date()): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
  return WEEKDAYS.indexOf(short);
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

// Localized month names indexed 0=Jan … 11=Dec, in the runtime locale. `style`
// picks long ("January") or short ("Jan") — calendars use short names in tight
// layouts. (Anchored on a fixed non-DST date so only the month text matters.)
export function monthNames(style: "long" | "short" = "long"): string[] {
  return Array.from({ length: 12 }, (_, m) =>
    new Date(2000, m, 1).toLocaleDateString(undefined, { month: style })
  );
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
