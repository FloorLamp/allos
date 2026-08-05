import type { DateRange } from "./timeline-format";
import { daysBetweenDateStr } from "./date";
import { formatCompactAge } from "./format-date";

// Pure helpers backing the Trends hub. The hub reuses the existing per-domain
// queries and then windows their date-keyed series to the shared from/to range
// in memory — so no query needs a new date-range parameter and every section
// respects the same control. All logic here is pure (no DB / no unit conversion)
// and unit-tested.

// SQLite treats a negative LIMIT as "no upper bound". The Trends sections must
// read a domain's WHOLE series before windowing it (filterSeriesByRange), so
// they pass this instead of a query's default row cap (getWeights /
// getBodyMetricsWithSource default to 365 rows, getInsights to 30) — otherwise a
// selected window older than the newest N rows would silently render an empty or
// partial chart, and even "All time" would be truncated.
export const ALL_ROWS = -1;

// Keep only the points whose ISO date (YYYY-MM-DD, which sorts chronologically as
// a plain string) falls inside the inclusive [from, to] window. An unset bound is
// open on that side, so an all-time range returns the series unchanged.
export function filterSeriesByRange<T extends { date: string }>(
  series: T[],
  range: DateRange
): T[] {
  const { from, to } = range;
  if (!from && !to) return series;
  return series.filter(
    (d) => (!from || d.date >= from) && (!to || d.date <= to)
  );
}

// The SPARSE-SERIES fallback (#1485 G). With 90D as the default window, a series
// measured once a year is empty in the default view — and a tile that answers "no
// data in this range" has thrown away the one number the user came for. So when a
// series has NO points inside the window but DOES have history, the surface shows
// its newest reading instead.
//
// Returns that reading, or null when the fallback does not apply — which is both
// of the cases where showing it would be a lie or a duplicate:
//   • the window has points of its own (the tile draws the real series), and
//   • the series is empty outright (a never-measured saved biomarker — the #1456
//     placeholder tile, whose ★ must stay reachable, still renders).
// `series` must be chronological (oldest → newest), as every series here is.
//
// This is a SELECTION, not a plot: the caller must render the returned reading as
// explicitly outside the window (see `outOfWindowAgeLabel`) and must never merge
// it into the charted points, or a stale value reads as a current one.
export function outOfWindowLatest<T extends { date: string }>(
  series: readonly T[],
  range: DateRange
): T | null {
  if (series.length === 0) return null;
  const { from, to } = range;
  const inWindow = series.some(
    (d) => (!from || d.date >= from) && (!to || d.date <= to)
  );
  if (inWindow) return null;
  return series[series.length - 1];
}

// The age label that rides an out-of-window reading — "4mo ago", "3y ago". This
// is the honesty half of the fallback and is NEVER optional at the call sites: it
// is the only thing distinguishing a five-month-old value from today's.
//
// Compact form (`formatCompactAge`) rather than the "5 months ago" long form: a
// trend tile is the dense, always-visible context #1216 minted that helper for,
// and it gets denser still under #1485 B's two-column mobile grid.
export function outOfWindowAgeLabel(date: string, todayStr: string): string {
  const compact = formatCompactAge(date, todayStr);
  // formatCompactAge says "Today" for a same-day reading; "Today ago" is not a
  // phrase. (Reachable only for a window that excludes today, e.g. a historical
  // custom range, but the label must read correctly there too.)
  return compact === "Today" ? "today" : `${compact} ago`;
}

// ---------------------------------------------------------------------------
// The lens window (#2043)
// ---------------------------------------------------------------------------

// ONE resolution of the hub's shared DateRange into the (anchor, weeks) pair a
// weekly lens reads. Two lenses on the same page used to resolve it separately —
// Fitness left `to` exactly as given while Practices clamped it to today — so a
// future-dated `to` made two sections of one page describe two different windows
// (#2043). The anchor rule is decided HERE, once; only the per-lens week CAPS are
// supplied by the caller, because those are genuine display decisions (the heatmap
// affords a year of columns, a practice strip half of one).
export interface LensWeekCaps {
  /** Fewest week columns a window may resolve to. */
  minWeeks: number;
  /** Most week columns a window may resolve to; an all-time window takes it. */
  maxWeeks: number;
}

export interface LensWindow {
  /** Inclusive first day, or null for a window open at the start. */
  from: string | null;
  /**
   * The window's ANCHOR: its last day, never in the future. A range ending in
   * the past keeps its end (a window over January describes January); a range
   * ending today, tomorrow, or not at all anchors on today.
   */
  to: string;
  /** Window length in inclusive days, or null when it has no start bound. */
  days: number | null;
  /** True when the range names no window at all ("All time"). */
  allTime: boolean;
  /** `days` in week columns, rounded up and clamped to the caller's caps. */
  weeks: number;
}

// How many week columns a span of days is worth: round the partial week UP so the
// window's edge day still has a column, then clamp. A null span (no start bound)
// is unbounded history and takes the cap.
export function clampLensWeeks(days: number | null, caps: LensWeekCaps): number {
  if (days == null) return caps.maxWeeks;
  return Math.min(caps.maxWeeks, Math.max(caps.minWeeks, Math.ceil(days / 7)));
}

export function lensWindow(
  range: DateRange,
  todayStr: string,
  caps: LensWeekCaps
): LensWindow {
  const to = range.to && range.to < todayStr ? range.to : todayStr;
  const from = range.from ?? null;
  const spanned = from ? daysBetweenDateStr(from, to) : null;
  // An unparseable date (never produced by the hub, which validates its params)
  // degrades to an unbounded span rather than a NaN-length window.
  const days = spanned == null ? null : Math.max(1, spanned + 1);
  return {
    from: days == null ? null : from,
    to,
    days,
    allTime: !range.from && !range.to,
    weeks: clampLensWeeks(days, caps),
  };
}

export interface SeriesSummary {
  count: number;
  first: number;
  last: number;
  // last − first, so a positive delta means the metric rose over the window.
  delta: number;
  direction: "up" | "down" | "flat";
}

// Summarize a windowed value series for a sparkline caption: how many points, the
// first and last values, and the net change. Assumes the series is already in
// chronological (oldest → newest) order — the order every body-metric/volume
// series is shaped into before charting. Returns null for an empty series so the
// caller can omit the caption.
export function summarizeSeries(
  series: { value: number | null }[]
): SeriesSummary | null {
  const values = series
    .map((p) => p.value)
    .filter((v): v is number => v != null);
  if (values.length === 0) return null;
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  return {
    count: values.length,
    first,
    last,
    delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
  };
}

// A human label for the active window, shown next to the range control on the
// hub. Mirrors the Timeline's "Through …" phrasing but covers both bounds.
export function rangeSummaryLabel(range: DateRange, todayStr: string): string {
  const { from, to } = range;
  if (!from && !to) return "All time";
  if (from && to) return from === to ? from : `${from} → ${to}`;
  if (from) return `From ${from}`;
  return `Through ${to === todayStr ? "today" : to}`;
}
