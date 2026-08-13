import {
  daysBetweenDateStr,
  MONTHS_LONG,
  MONTHS_SHORT,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  zonedDateParts,
} from "./date";

// ---- Display-format preferences (login tier, issue #964) ----
// Two closed-enum display preferences that let a login choose how times and dates
// render, without any i18n/CLDR machinery: `timeFormat` (12h vs 24h clock) and
// `dateFormat` (the order/shape of a written date). They're stored per login in
// login_settings and resolved to this shape by
// lib/settings/display.getDisplayFormatPrefs; the pure formatters below take the
// resolved prefs as an argument (they never read the DB), so they stay client-safe
// and unit-testable. DEFAULT_FORMAT_PREFS reproduces today's dominant rendering
// byte-for-byte (24h clock; the "Mon D, YYYY" / long-date shape) so an instance
// that never opts in sees no change. Login-less surfaces (Telegram/push/HA sends,
// the token-authed .ics feed) have a profile but no login in context, so they pass
// a FIXED format (their documented status quo per channel) rather than resolving a
// pref — see each such call site.
export type TimeFormat = "12h" | "24h";
export type DateFormat = "mdy" | "dmy" | "iso";

export interface DisplayFormatPrefs {
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

export const DEFAULT_FORMAT_PREFS: DisplayFormatPrefs = {
  timeFormat: "24h",
  dateFormat: "mdy",
};

// Fixed English calendar names — the app is single-language by design (non-goal:
// no full i18n), and hardcoding them is precisely what removes the server-locale
// dependence that an implicit-locale toLocale call leaked (the record-format.ts
// bug, #964). On an en-US host they are byte-identical to the old toLocale output.
// The tables live in lib/date.ts (shared with monthNames(), #1020) and are imported
// above.

const pad2 = (n: number) => String(n).padStart(2, "0");

// Render a wall-clock time (h 0–23, m 0–59) in the chosen format. 24h → "16:02"
// (zero-padded hour). 12h → "4:02 PM" with `meridiem: "upper-space"` (the record /
// .ics style) or "4:02pm" with "lower-nospace" (the administration / medications
// style). Midnight folds to 12 AM and noon to 12 PM. Pure — the seam every clock
// render routes through so one login sees one clock convention everywhere (#964).
export function formatClock(
  timeFormat: TimeFormat,
  h: number,
  m: number,
  meridiem: "upper-space" | "lower-nospace" = "upper-space"
): string {
  if (timeFormat === "24h") return `${pad2(h)}:${pad2(m)}`;
  const lower = meridiem === "lower-nospace";
  const ap = h >= 12 ? (lower ? "pm" : "PM") : lower ? "am" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  const sep = lower ? "" : " ";
  return `${h12}:${pad2(m)}${sep}${ap}`;
}

// Render a minute-of-day (0..1439) as a wall clock through the SAME pref seam as
// `formatClock`, so a pure model can emit a time NUMBER and let the render layer
// pick the clock convention (issue #1163 — models emit time numbers, one formatter
// produces the string). Values are normalized modulo the day, so a noon-anchored
// hour (12..36) mapped to minutes wraps correctly (1440 → 00:00). Pure.
export function formatClockMinutes(
  timeFormat: TimeFormat,
  minutesOfDay: number,
  meridiem: "upper-space" | "lower-nospace" = "upper-space"
): string {
  const total = (((Math.round(minutesOfDay) % 1440) + 1440) % 1440) | 0;
  return formatClock(timeFormat, Math.floor(total / 60), total % 60, meridiem);
}

// Format stored/read-only clock text through the same login preference seam as
// `formatClock`. Accepts canonical HH:MM[:SS] and legacy 12-hour display strings;
// unknown imported text is preserved rather than silently disappearing.
export function formatClockValue(
  value: string | null | undefined,
  timeFormat: TimeFormat = DEFAULT_FORMAT_PREFS.timeFormat,
  fallback = "",
  meridiem: "upper-space" | "lower-nospace" = "upper-space"
): string {
  if (!value) return fallback;
  const clock = value.trim();
  if (!clock) return fallback;
  const twentyFour = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clock);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour <= 23 && minute <= 59) {
      return formatClock(timeFormat, hour, minute, meridiem);
    }
  }
  const twelveHour = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(clock);
  if (twelveHour) {
    const hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2]);
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      const hour24 =
        (hour % 12) + (twelveHour[3].toLowerCase() === "p" ? 12 : 0);
      return formatClock(timeFormat, hour24, minute, meridiem);
    }
  }
  return clock;
}

// Shape a calendar date (y full year, m 1-based 1–12, d day-of-month) into the
// chosen order and style. `monthStyle` picks "Jan"/"January" (ignored for "iso",
// which is always numeric YYYY-MM-DD). `weekday` (a full weekday name) prefixes
// "Weekday, " when given. `year` appends the year (always present for "iso"). Pure,
// fixed-English (no server-locale dependence). The DEFAULT "mdy" reproduces the
// en-US toLocale output byte-for-byte: mdy → "Jan 5, 2026" / "Monday, January 5,
// 2026"; dmy → "5 Jan 2026"; iso → "2026-01-05".
export function formatDateShape(
  dateFormat: DateFormat,
  y: number,
  m: number,
  d: number,
  opts: { monthStyle?: "short" | "long"; weekday?: string; year?: boolean } = {}
): string {
  const { monthStyle = "short", weekday, year = false } = opts;
  const prefix = weekday ? `${weekday}, ` : "";
  if (dateFormat === "iso") {
    return `${prefix}${y}-${pad2(m)}-${pad2(d)}`;
  }
  const month = (monthStyle === "long" ? MONTHS_LONG : MONTHS_SHORT)[m - 1];
  if (dateFormat === "dmy") {
    return `${prefix}${d} ${month}${year ? ` ${y}` : ""}`;
  }
  // "mdy" (default)
  return `${prefix}${month} ${d}${year ? `, ${y}` : ""}`;
}

// Process-local calendar date (YYYY-MM-DD), used only as a backward-compatible
// default for callers that can't easily pass the app's configured "today". Prefer
// passing an explicit todayStr (server: today() from lib/db; client:
// dateStrInTz(useTimezone())) so day math follows the app's timezone.
function localTodayStr(): string {
  const n = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

// ---- The display vocabulary (issue #1448) ----
// One question ("how does this instance display a date?"), one computation. Every
// rendered date/time picks the entry that matches its CONTEXT; nothing hand-rolls a
// shape. Under the default prefs the four read:
//
//   formatLongDate      "Friday, July 24"     day-scoped headers, in-app, auto-year
//   formatMonthDay      "Jul 24"              dense chips/labels, in-app, auto-year
//   formatDateWithYear  "Jul 24, 2026"        print/export/anything leaving the app
//   formatTimestamp     "Jul 24, 2026, 22:14" an absolute instant (stamps, ops rows)
//
// "auto-year" = the year is appended only outside the current calendar year, which
// is right for an in-app surface and WRONG for one that outlives the session (see
// formatDateWithYear). All four honor the login's dateFormat/timeFormat prefs; the
// pure guard lib/__tests__/date-locale-guard.test.ts fails CI on a pref-less call
// and on any implicit-locale toLocale* date render.

// Consistent training log date formatting: "Weekday, Month Day", with the year
// appended only when it isn't the current calendar year by default. A dense set
// that can cross years may request `year: "always"` while retaining this same long
// shape. Input is an ISO YYYY-MM-DD string (parsed as local midnight so the day
// doesn't shift). Pref-aware (#964): the `dateFormat` reorders the month/day; the
// DEFAULT "mdy" is byte-identical to the old en-US toLocale output ("Monday,
// January 5[, 2026]").
export function formatLongDate(
  iso: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  options: { year?: "auto" | "always" } = {}
): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateShape(
    prefs.dateFormat,
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    {
      monthStyle: "long",
      weekday: WEEKDAYS_LONG[d.getDay()],
      year:
        options.year === "always" ||
        d.getFullYear() !== new Date().getFullYear(),
    }
  );
}

// Short "Month Day" label (e.g. "Aug 3") for compact contexts like the refill
// run-out chip (#852 item 3). ISO YYYY-MM-DD in, parsed as local midnight so the day
// doesn't shift; the year is appended only when it isn't the current calendar year.
// Pref-aware (#964): the DEFAULT "mdy" is byte-identical to the old output ("Aug 3").
export function formatMonthDay(
  iso: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateShape(
    prefs.dateFormat,
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    {
      monthStyle: "short",
      year: d.getFullYear() !== new Date().getFullYear(),
    }
  );
}

// Full calendar date that ALWAYS carries its year — "Jul 24, 2026" (mdy),
// "24 Jul 2026" (dmy), "2026-07-24" (iso). The year-bearing sibling of
// formatMonthDay, which drops the year inside the current calendar year because
// its callers are in-app chips where "this year" is unambiguous from context.
//
// That auto-year rule breaks the moment a date LEAVES the app (issue #1448): the
// printable medication list rendered its "Generated" stamp with the year and the
// same card's STARTED column with formatLongDate — "Generated Jul 24, 2026, 22:14"
// beside "Friday, July 24" — two shapes in one card, the second undated once the
// paper outlives the year. Print/export surfaces use THIS, never the auto-year
// formatters. Pure, fixed-English, pref-aware like the rest of the vocabulary.
export function formatDateWithYear(
  iso: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateShape(
    prefs.dateFormat,
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    { monthStyle: "short", year: true }
  );
}

// Compact weekday + date label for selectors and other dense calendar contexts:
// "Wed, Jul 22" (mdy), "Wed, 22 Jul" (dmy), or "Wed, 2026-07-22" (iso).
// Like the other date helpers, it uses the fixed English calendar tables and keeps
// the year only when the date falls outside the current calendar year.
export function formatWeekdayDate(
  iso: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateShape(
    prefs.dateFormat,
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    {
      monthStyle: "short",
      weekday: WEEKDAYS_SHORT[d.getDay()],
      year: d.getFullYear() !== new Date().getFullYear(),
    }
  );
}

// Parse the two timestamp serializations the app stores: an ISO instant
// ("2026-07-24T22:14:15.000Z", the JSONL logs) and SQLite's zone-less
// `datetime('now')` form ("2026-07-24 22:14:15", the audit table), the latter
// normalized to explicit UTC so it can't be read as local time. Returns null when
// unparseable so a caller can fall back to the raw text rather than print "Invalid
// Date".
function parseTimestamp(input: string | number | Date): Date | null {
  if (input instanceof Date)
    return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = input.trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Date + clock in ONE shape — "Jul 24, 2026, 22:14" — the vocabulary entry for an
// absolute point in time (a print "Generated" stamp, an ops-table row time).
//
// `zone: "utc"` reads the instant in UTC rather than the runtime's zone. That is
// what the admin ops tables want (issue #1448): Audit rendered SQLite's raw
// `2026-07-24 22:14:15` while its sibling Errors/AI-log tables rendered
// `toLocaleString()` — the SERVER's zone when server-rendered and the BROWSER's
// after hydration, so the same three admin screens disagreed with each other AND
// with themselves across a hydration boundary. Reading them all as UTC (with the
// column header saying so) makes the trio one family and makes the render
// deterministic. In-app surfaces keep the default "local".
//
// Always carries the year, for the same reason formatDateWithYear does — a
// timestamp names a specific instant, so an undated one is a bug. Pure.
interface TimestampFormatOptions {
  zone?: "local" | "utc";
  timeZone?: string;
}

export interface TimestampDisplay {
  absolute: string;
  clock: string;
}

// Resolve the absolute label and its clock from ONE wall-time projection. An
// explicit IANA timezone takes precedence over local/UTC because profile-owned
// ledgers must render in the same zone that assigned their calendar day.
export function formatTimestampDisplay(
  input: string | number | Date,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  opts: TimestampFormatOptions = {}
): TimestampDisplay | null {
  const d = parseTimestamp(input);
  if (!d) return null;
  const zoned = opts.timeZone ? zonedDateParts(opts.timeZone, d) : null;
  const utc = opts.zone === "utc";
  const [zonedYear, zonedMonth, zonedDay] =
    zoned?.date.split("-").map(Number) ?? [];
  const [zonedHour, zonedMinute] = zoned?.hhmm.split(":").map(Number) ?? [];
  const date = formatDateShape(
    prefs.dateFormat,
    zoned ? zonedYear : utc ? d.getUTCFullYear() : d.getFullYear(),
    zoned ? zonedMonth : (utc ? d.getUTCMonth() : d.getMonth()) + 1,
    zoned ? zonedDay : utc ? d.getUTCDate() : d.getDate(),
    { monthStyle: "short", year: true }
  );
  const clock = formatClock(
    prefs.timeFormat,
    zoned ? zonedHour : utc ? d.getUTCHours() : d.getHours(),
    zoned ? zonedMinute : utc ? d.getUTCMinutes() : d.getMinutes()
  );
  return { absolute: `${date}, ${clock}`, clock };
}

export function formatTimestamp(
  input: string | number | Date,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  opts: TimestampFormatOptions = {}
): string {
  return (
    formatTimestampDisplay(input, prefs, opts)?.absolute ??
    (typeof input === "string" ? input : "")
  );
}

// A human "time since" label: Today / Yesterday / N days|weeks|months|years ago.
// Day math is calendar-based against `todayStr` (the app's configured today), so
// it's timezone-independent. `todayStr` is required so a caller can never
// accidentally use the server's local day for profile-scoped data (#1186).
export function formatRelativeDate(iso: string, todayStr: string): string {
  const days = daysBetweenDateStr(iso, todayStr); // today − iso
  if (days == null) return iso;
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (days < 30) return plural(Math.round(days / 7), "week");
  if (days < 365) return plural(Math.round(days / 30), "month");
  return plural(Math.round(days / 365), "year");
}

// Compact "age" label for dense, always-visible contexts where the full
// "N weeks ago" form doesn't fit — a lab row's date column at phone width (#1216).
// Same calendar-based day math as formatRelativeDate against `todayStr` (so it's
// timezone-independent), abbreviated: "Today" / "5d" / "2w" / "4mo" / "3y". The
// week/month/year thresholds match formatRelativeDate so the two never disagree on
// which bucket a date lands in.
export function formatCompactAge(iso: string, todayStr: string): string {
  const days = daysBetweenDateStr(iso, todayStr); // today − iso
  if (days == null) return iso;
  if (days <= 0) return "Today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

// The clock-skew tolerance around `now`, in seconds (#2522). An instant a few
// seconds either side of the reader's clock is the SAME moment reported by two
// machines, so it reads "just now" whichever side it falls on. Beyond it, a future
// instant is a real statement about the future and takes the forward vocabulary.
//
// BOUNDED, not one-sided — that was the whole defect. The age is a SIGNED
// difference and only its upper edge was ever tested, so any future instant made
// `secs` negative and won the "just now" branch: ten seconds ahead and twenty-two
// hours ahead produced the same string. The illness cockpit showed a 08:00
// temperature and a 23:39 dose both "(just now)" at 01:10.
const RELATIVE_SKEW_SECS = 45;

// Fine-grained "time since" for timestamps (not just calendar dates): "just
// now", "N minutes/hours ago", then day granularity ("Yesterday", "N days ago",
// weeks/months/years). Accepts an ISO string or a SQLite UTC datetime
// ("YYYY-MM-DD HH:MM:SS"), the latter parsed as UTC (not local). `now` is
// injectable for testing.
//
// FORWARD AS WELL AS BACK (#2522). A stated time can genuinely be later than the
// reader's clock — the illness cockpit's "Reading time" is a user-owned input, and
// a dose's recorded instant can sit a moment ahead of the device reading it — and a
// future instant is a fact to state, not an error to hide. So the same buckets run
// mirrored ("in 7 hrs", "Tomorrow"), and beyond the tolerance nothing is ever
// labelled with an age it does not have. The one answer this must never give is the
// one it used to: "just now" for a reading nobody has taken yet, on a safety-tier
// card whose whole job is to answer "when was the last dose".
export function formatRelativeTime(
  input: string,
  now: Date = new Date()
): string {
  // SQLite's datetime('now') has no zone marker and would parse as local time;
  // normalize the "date SP time" form to explicit UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input)
    ? `${input.replace(" ", "T")}Z`
    : input;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return input;

  const secs = Math.round((now.getTime() - d.getTime()) / 1000);
  if (Math.abs(secs) < RELATIVE_SKEW_SECS) return "just now";
  return secs < 0 ? forwardLabel(-secs) : pastLabel(secs);
}

// The past half: "N minutes ago" … "N years ago", with "Yesterday" at one day.
function pastLabel(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (days < 30) return plural(Math.round(days / 7), "week");
  if (days < 365) return plural(Math.round(days / 30), "month");
  return plural(Math.round(days / 365), "year");
}

// The forward half, mirroring `pastLabel` bucket for bucket so one instant seven
// hours either side of now reads with the same granularity in both directions.
// `secs` is the POSITIVE distance into the future.
function forwardLabel(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Tomorrow";
  if (days < 7) return `in ${days} days`;
  const plural = (n: number, unit: string) =>
    `in ${n} ${unit}${n === 1 ? "" : "s"}`;
  if (days < 30) return plural(Math.round(days / 7), "week");
  if (days < 365) return plural(Math.round(days / 30), "month");
  return plural(Math.round(days / 365), "year");
}

// Compact variant for dense status lines. It preserves the app-wide relative-time
// thresholds while shortening only minute/hour units ("2 hrs ago"); day-and-longer
// labels stay unabbreviated because they are already concise and easier to scan.
// The forward labels (#2522) abbreviate on the same rule ("in 7 hrs").
export function formatCompactRelativeTime(
  input: string,
  now: Date = new Date()
): string {
  return formatRelativeTime(input, now)
    .replace(/^(\d+) minute ago$/, "$1 min ago")
    .replace(/^(\d+) minutes ago$/, "$1 mins ago")
    .replace(/^(\d+) hour ago$/, "$1 hr ago")
    .replace(/^(\d+) hours ago$/, "$1 hrs ago")
    .replace(/^in (\d+) minute$/, "in $1 min")
    .replace(/^in (\d+) minutes$/, "in $1 mins")
    .replace(/^in (\d+) hour$/, "in $1 hr")
    .replace(/^in (\d+) hours$/, "in $1 hrs");
}

// Whole days from `todayStr` to an ISO date: positive = future, negative = past,
// 0 = today. Calendar-based (timezone-independent); defaults to the process-local
// date for compatibility. Null when unparseable.
export function daysUntil(
  iso: string,
  todayStr: string = localTodayStr()
): number | null {
  return daysBetweenDateStr(todayStr, iso); // iso − today
}

// Countdown label for a target date: "12 days left" / "today" / "tomorrow" /
// "3 days overdue". Null when unparseable.
export function daysRemainingLabel(
  iso: string,
  todayStr: string = localTodayStr()
): string | null {
  const n = daysUntil(iso, todayStr);
  if (n == null) return null;
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "1 day overdue";
  return n > 0 ? `${n} days left` : `${-n} days overdue`;
}
