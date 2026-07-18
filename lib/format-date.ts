import { daysBetweenDateStr } from "./date";

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
// no full i18n), and hardcoding these is precisely what removes the server-locale
// dependence that `toLocaleString(undefined, …)` leaked (the record-format.ts bug,
// #964). On an en-US host these are byte-identical to the old toLocale output.
const MONTHS_LONG = [
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
];
const MONTHS_SHORT = [
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
];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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

// Consistent journal date formatting: "Weekday, Month Day", with the year
// appended only when it isn't the current calendar year. Input is an ISO
// YYYY-MM-DD string (parsed as local midnight so the day doesn't shift). Pref-aware
// (#964): the `dateFormat` reorders the month/day; the DEFAULT "mdy" is
// byte-identical to the old en-US toLocale output ("Monday, January 5[, 2026]").
export function formatLongDate(
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
      monthStyle: "long",
      weekday: WEEKDAYS_LONG[d.getDay()],
      year: d.getFullYear() !== new Date().getFullYear(),
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

// A human "time since" label: Today / Yesterday / N days|weeks|months|years ago.
// Day math is calendar-based against `todayStr` (the app's configured today), so
// it's timezone-independent; defaults to the process-local date for compatibility.
export function formatRelativeDate(
  iso: string,
  todayStr: string = localTodayStr()
): string {
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

// Fine-grained "time since" for timestamps (not just calendar dates): "just
// now", "N minutes/hours ago", then day granularity ("Yesterday", "N days ago",
// weeks/months/years). Accepts an ISO string or a SQLite UTC datetime
// ("YYYY-MM-DD HH:MM:SS"), the latter parsed as UTC (not local). `now` is
// injectable for testing.
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
  if (secs < 45) return "just now";
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
