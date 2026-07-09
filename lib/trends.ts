import type { DateRange } from "./timeline-format";

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
