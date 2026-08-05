import type { DateRange } from "./timeline-format";
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

// Summarizing a windowed series — how many points, the endpoint values, the net
// change and its direction — is `robustSeriesSummary` in lib/trends-digest.ts, NOT a
// helper here (#2044). This module used to also carry a `summarizeSeries` that read
// the LITERAL first and last points; it had zero non-test callers, because measuring
// direction off raw endpoints lets a single noisy edge reading invent a trend (#37) —
// which is exactly why `robustSeriesSummary` measures between MEDIAN endpoints and is
// the one every surface consumes (the Overview TrendMiniCard badge and the trending
// digest, so a tile arrow and a digest chip can never disagree on one screen).
// Pointer kept here rather than a re-export, so "series summary" greps to the single
// survivor instead of finding the noisy semantics first in the more general-sounding
// module.

// A human label for the active window, shown next to the range control on the
// hub. Mirrors the Timeline's "Through …" phrasing but covers both bounds.
export function rangeSummaryLabel(range: DateRange, todayStr: string): string {
  const { from, to } = range;
  if (!from && !to) return "All time";
  if (from && to) return from === to ? from : `${from} → ${to}`;
  if (from) return `From ${from}`;
  return `Through ${to === todayStr ? "today" : to}`;
}
