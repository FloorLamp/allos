// The ONE trailing-average computation over a dated series (#1909, the #221 rule).
//
// Two adjacent surfaces used to answer "what is this metric's 7-day average?" with
// two independent aggregations that disagreed BY CONSTRUCTION: the dashboard's
// Steps-today card averaged the last 7 DATA-BEARING days strictly before today,
// while the metric detail page's Rolling summary averaged the last 7 CALENDAR days
// INCLUDING a today that was still only half over. Same metric, same morning, two
// numbers, both labelled "7-day average".
//
// The divergence that survives is deliberate and is now a DECLARED parameter rather
// than an accident of two implementations:
//
//   - `basis: "data-bearing"` — the last N days that CARRY a reading. Gaps reach
//     further back, so the sample size is stable (a watch that missed three days
//     still yields a 7-day mean) and the window's span is not. This is what "my
//     usual day" means for a card comparing today against a norm.
//   - `basis: "calendar"` — the last N calendar days, gaps and all. The span is
//     fixed and the sample shrinks, so "30d" genuinely means the last 30 days.
//     This is what a period summary claims when it prints a date range.
//
// `includeToday` defaults to FALSE: a trailing average is HISTORY, and today is not
// history until it ends. For a cumulative daily metric (steps, active minutes) an
// included today drags the mean down all afternoon and self-corrects at midnight —
// the partial-today understatement #1909 was filed for. For a point-in-time metric
// (weight, resting HR) it dampens today's own delta against the baseline it is
// being compared to. Callers that genuinely want recency ask for it by name.
//
// The result is UNROUNDED. Rounding is presentation (the steps card wants whole
// steps, the metric detail page wants the metric's own decimals) and baking one
// into the shared computation would just move the divergence somewhere quieter.

import { shiftDateStr } from "./date";

export type TrailingWindowBasis = "data-bearing" | "calendar";

export interface TrailingPoint {
  date: string;
  value: number;
}

export interface TrailingWindowSpec {
  // The window size, N. Days for "calendar", readings for "data-bearing".
  days: number;
  basis: TrailingWindowBasis;
  // Whether the anchor day itself belongs in the sample. Default FALSE — the
  // window ends on the day BEFORE `todayStr` and covers complete days only.
  includeToday?: boolean;
}

export interface TrailingWindow<P extends TrailingPoint = TrailingPoint> {
  // The sample the average covers, ascending by date — what was averaged, so a
  // caller needing min/max/first/last derives them from the SAME selection rather
  // than re-windowing the series itself.
  points: P[];
  count: number;
  // First / last DATE actually present in the sample (null when it is empty).
  from: string | null;
  to: string | null;
  // The unrounded arithmetic mean, or null when the sample is empty.
  average: number | null;
}

// The trailing window ending at (or the day before) `todayStr`, plus its mean.
// Accepts the series in any order and returns the sample ascending; a
// data-bearing window is only meaningful on a sorted series. Readings dated after
// the window's end — a future-dated manual entry — are never in a TRAILING window.
export function trailingAverage<P extends TrailingPoint>(
  points: readonly P[],
  todayStr: string,
  spec: TrailingWindowSpec
): TrailingWindow<P> {
  const { days, basis, includeToday = false } = spec;
  const end = includeToday ? todayStr : shiftDateStr(todayStr, -1);
  const asc = points
    .filter((p) => p.date <= end)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const sample =
    basis === "calendar"
      ? asc.filter((p) => p.date >= shiftDateStr(end, -(days - 1)))
      : asc.slice(-days);

  if (sample.length === 0) {
    return { points: [], count: 0, from: null, to: null, average: null };
  }
  const sum = sample.reduce((total, p) => total + p.value, 0);
  return {
    points: sample,
    count: sample.length,
    from: sample[0].date,
    to: sample[sample.length - 1].date,
    average: sum / sample.length,
  };
}
