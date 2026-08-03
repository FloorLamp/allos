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
//
// DAY ONE (#1909's follow-up ruling). "Complete days only" has one honest but
// unkind consequence: on the day someone records their FIRST reading there is
// nothing to average, so a summary card read "No readings" all day — precisely
// when the person is checking whether the entry they just made worked. The
// fallback lives HERE, once, so every consumer inherits the same day-one
// behaviour instead of four call sites each inventing one.
//
// The trigger is "NO COMPLETE-DAY HISTORY AT ALL", never "the window is empty".
// A profile with readings from three weeks ago and nothing since HAS complete-day
// history: its 7-day calendar window is legitimately empty and stays empty.
// Falling back there would print today's number as though it were an average —
// the exact defect #1909 removed. So the fallback fires only when there is no
// reading on or before the window's end date anywhere in the series, and today
// carries one.
//
// `dayOneFallback` says which it is, and a surface MUST NOT ignore it: the value
// is today's reading, not a completed-day mean, so a caller either QUALIFIES it
// ("today's reading") or DECLINES it — the Steps card declines, because its whole
// question is today versus PRIOR days and today cannot be its own baseline.

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
  // Declared by a caller whose `points` are TRUNCATED to the window — a gather that
  // reads only the days the window can contain rather than the whole series. Day
  // one means "no complete-day history AT ALL", and a truncated series cannot
  // answer that: a profile that logged a month ago and again today arrives here
  // looking exactly like a first-ever reading. Such a caller states here whether
  // anything older exists, so the ONE day-one rule still decides. A caller passing
  // the full series leaves it alone.
  hasEarlierHistory?: boolean;
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
  // TRUE when this window is the DAY-ONE fallback: the series holds no reading on
  // or before the window's end date at all, so `points`/`average` describe TODAY's
  // reading rather than a completed-day mean. A surface must qualify the number or
  // decline it — never label it an average (see the module header).
  dayOneFallback: boolean;
}

const EMPTY_WINDOW = {
  count: 0,
  from: null,
  to: null,
  average: null,
  dayOneFallback: false,
} as const;

function ascending<P extends TrailingPoint>(points: readonly P[]): P[] {
  return points
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function summarize<P extends TrailingPoint>(
  sample: P[],
  dayOneFallback: boolean
): TrailingWindow<P> {
  const sum = sample.reduce((total, p) => total + p.value, 0);
  return {
    points: sample,
    count: sample.length,
    from: sample[0].date,
    to: sample[sample.length - 1].date,
    average: sum / sample.length,
    dayOneFallback,
  };
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
  const { days, basis, includeToday = false, hasEarlierHistory = false } = spec;
  const end = includeToday ? todayStr : shiftDateStr(todayStr, -1);
  // Every reading the window could draw on — i.e. the profile's COMPLETE-DAY
  // history when today is excluded. Its emptiness is the day-one trigger below,
  // and it is not the same test as the SAMPLE being empty.
  const eligible = ascending(points.filter((p) => p.date <= end));

  const sample =
    basis === "calendar"
      ? eligible.filter((p) => p.date >= shiftDateStr(end, -(days - 1)))
      : eligible.slice(-days);

  if (sample.length > 0) return summarize(sample, false);

  // Day one: nothing on or before the window's end ANYWHERE in the series, and a
  // reading today. A series with history the window happens to miss (a gap) has
  // `eligible.length > 0` — or, for a caller whose series is truncated to the
  // window, `hasEarlierHistory` — and stays empty. That window is honestly empty.
  if (!includeToday && eligible.length === 0 && !hasEarlierHistory) {
    const todays = ascending(points.filter((p) => p.date === todayStr));
    if (todays.length > 0) return summarize(todays, true);
  }
  return { points: [], ...EMPTY_WINDOW };
}
