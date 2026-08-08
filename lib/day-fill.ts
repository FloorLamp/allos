// Day-grain chart-axis fill (issue #2258) — the DAY twin of lib/weekly-fill.ts.
//
// recharts treats a string `dataKey` as a CATEGORY axis: x-position is the array
// INDEX, not the date. A day-precision series that only carries the days it HAS a
// reading for therefore compresses its gaps away — a four-night sync outage plots
// as four adjacent, evenly spaced points with the stroke bridging them, visually
// identical to four consecutive nights. Same failure #406 fixed for weekly bars,
// one grain down, and on far more surfaces (steps, calories, sleep, daily vitals,
// body composition, macros, every trend tile).
//
// The fix is to densify to the CALENDAR before the chart sees the series: one
// entry per day in the window, with the missing days carrying the series' declared
// gap value. What that value is — a `null` hole or a real `0` — is NOT this
// module's decision: it is a property of the QUANTITY (see lib/trend-sparkline.ts,
// which owns the per-series `gap` declaration). This module owns only the calendar
// arithmetic and the trimming rule.
//
// THE TRIMMING RULE, mirroring `weeklyChartWeeks`:
//
//   • LEADING empty days — before the first reading — are TRIMMED. A window that
//     opens two months before you owned a scale should not draw two months of
//     nothing; the series starts where the data starts.
//   • TRAILING days, to the window's end, are KEPT. This is the asymmetry that
//     the whole issue exists for: a run of nulls at the right edge is the LIVE
//     OUTAGE — "the last four nights did not sync" — and trimming it back to the
//     last reading is exactly the lie that made a stalled integration invisible.
//
// Pure calendar arithmetic over UTC-anchored YYYY-MM-DD strings (lib/date.ts). No
// DB, no React, no timezone — client-safe and unit-tested.

import { daysBetweenDateStr, shiftDateStr } from "./date";
import type { DateRange } from "./timeline-format";

/** What a missing calendar day carries. Declared per series, never per surface. */
export type DayGapFill = "null" | "zero";

/**
 * The window a series is densified to. Both bounds may be absent (an all-time
 * range): an absent `from` starts at the first reading (which the leading trim
 * would have produced anyway), and an absent `to` ends at the LAST reading — an
 * all-time chart's span IS its data, so it grows no trailing tail.
 */
export interface DayFillWindow {
  from: string | null;
  to: string | null;
}

/**
 * The shared Trends `DateRange` as a fill window. One conversion, here, so no
 * surface has to remember that an absent bound means "the data's own edge" — and
 * so `?? null` cannot be written two different ways on two pages.
 */
export function dayFillWindow(range: DateRange): DayFillWindow {
  return { from: range.from ?? null, to: range.to ?? null };
}

// The widest span this module will enumerate (~10 years of days). Beyond it the
// fill DEGRADES to the raw series rather than truncating: a truncated axis would
// silently drop real readings, which is a worse lie than the compression this
// module fixes. In practice unreachable — every quick range is ≤ 1 year, and an
// all-time window past this span already plots through the #1938 month-grain
// aggregation, which re-derives its own calendar buckets.
export const MAX_FILL_DAYS = 3660;

/**
 * Every calendar day from `first` to `last` inclusive, oldest first. Empty when
 * `last` precedes `first`, or when either date is unparseable, or when the span
 * exceeds MAX_FILL_DAYS.
 */
export function daysInclusive(first: string, last: string): string[] {
  const span = daysBetweenDateStr(first, last);
  if (span == null || span < 0 || span > MAX_FILL_DAYS) return [];
  const out: string[] = [];
  let d = first;
  for (let i = 0; i <= span; i++) {
    out.push(d);
    d = shiftDateStr(d, 1);
  }
  return out;
}

/**
 * The contiguous calendar-day axis a day-grain chart should render for `dataDates`
 * inside `window`: from the FIRST data day (leading empties trimmed) through the
 * later of the last data day and the window's end (trailing kept). Empty when
 * there is no data — a chart with nothing to plot draws its empty state, not a
 * month of holes.
 */
export function dailyChartDays(
  dataDates: readonly string[],
  window: DayFillWindow
): string[] {
  if (dataDates.length === 0) return [];
  let first = dataDates[0];
  let last = dataDates[0];
  for (const d of dataDates) {
    if (d < first) first = d;
    if (d > last) last = d;
  }
  const end = window.to != null && window.to > last ? window.to : last;
  return daysInclusive(first, end);
}

/**
 * Densify any dated row shape to the calendar. `blank(date)` builds the row a
 * missing day gets — the caller supplies it because the shape (one `value`, four
 * stacked macro keys) and the fill value are both the SERIES' business, not this
 * module's.
 *
 * Rows are returned oldest-first. A real row always wins its day; when two rows
 * share a date the LAST one in input order is kept (the callers hand over an
 * already-deduped, chronological series, so this is a defensive tiebreak rather
 * than a policy). When the span is unfillable (see MAX_FILL_DAYS) the input is
 * returned untouched — today's behaviour, never a truncated one.
 */
export function fillDailyRows<T extends { date: string }>(
  rows: readonly T[],
  window: DayFillWindow,
  blank: (date: string) => T
): T[] {
  if (rows.length === 0) return [];
  const days = dailyChartDays(
    rows.map((r) => r.date),
    window
  );
  if (days.length === 0) return [...rows];
  const byDate = new Map<string, T>();
  for (const r of rows) byDate.set(r.date, r);
  return days.map((date) => byDate.get(date) ?? blank(date));
}

/**
 * The common case: a `{ date, value }` line/bar series, densified with the given
 * fill. `"zero"` asserts a real measured zero on the missing day (a rest day's
 * training volume); `"null"` asserts nothing at all (a sensor that did not
 * report), and leaves the chart to draw a hole.
 */
export function fillDailySeries<
  T extends { date: string; value: number | null },
>(
  points: readonly T[],
  window: DayFillWindow,
  fill: DayGapFill
): { date: string; value: number | null }[] {
  return fillDailyRows<{ date: string; value: number | null }>(
    points,
    window,
    (date) => ({ date, value: fill === "zero" ? 0 : null })
  );
}
