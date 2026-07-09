import { daysBetweenDateStr } from "./date";

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
// YYYY-MM-DD string (parsed as local midnight so the day doesn't shift).
export function formatLongDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
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
