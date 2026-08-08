// Long-range chart aggregation (#1938): a year of daily readings must not plot as
// a point-per-day scribble.
//
// The 1Y quick range (and "All time" over a long dense series) hands a line chart
// hundreds-to-thousands of points, which renders as the unreadable dense trace
// #1932 documents on the SpO2 page. At that horizon the honest unit of signal is
// the WEEK (or, past two years, the MONTH): the chart plots each bucket's mean and
// carries the bucket's low–high spread as a band, so day-to-day noise becomes
// visible spread instead of visual noise.
//
// This module is the ONE decision + the ONE computation (the #221 rule): every
// chart that aggregates a long window does it through `aggregateLongRange`, so two
// surfaces showing the same series can never bucket it two different ways. It is
// pure and rendering-agnostic — the chart component applies it and draws the band;
// nothing here knows about recharts.
//
// WHEN it aggregates is as load-bearing as how:
//
//   • Span, not point count, picks the GRAIN. A window at or under
//     LONG_RANGE_MIN_DAYS (which covers every pre-#1938 quick range, 90D
//     included) always plots raw — this module must never change a chart that was
//     already legible. Past ~2 years, weekly buckets are themselves a scribble,
//     so the grain steps to months.
//   • Density decides WHETHER. A sparse series over a long span — weekly
//     weigh-ins, monthly labs — is already legible, and bucketing it would mostly
//     relabel real readings with bucket-start dates while the "band" collapsed to
//     the point itself. Aggregation therefore requires at least
//     LONG_RANGE_MIN_DENSITY readings per occupied bucket on average; below that
//     the answer is null and the caller plots the raw series.
//
// Buckets are CALENDAR-anchored (weeks via startOfWeekStr, months by the first of
// the month), not trailing chunks anchored on the window's edge: a calendar bucket
// means the same thing tomorrow, so a chart re-rendered a day later shifts by one
// bucket instead of re-cutting every one. All arithmetic is the UTC-anchored
// calendar math in lib/date.ts — no DST, no timezone.

import { daysBetweenDateStr, shiftDateStr, startOfWeekStr } from "./date";

export type LongRangeGrain = "week" | "month";

// A span longer than this aggregates. 180 keeps every shorter quick range (7D /
// 30D / 90D) and a half-year custom window plotting raw points.
export const LONG_RANGE_MIN_DAYS = 180;

// A span longer than this steps the grain from weeks to months (~104 weekly
// buckets — about two years — is where weekly means stop being readable).
export const MONTH_GRAIN_MIN_DAYS = 731;

// Mean readings per OCCUPIED bucket required before aggregation applies. Two is
// the smallest density at which a bucket mean says something a raw point doesn't.
export const LONG_RANGE_MIN_DENSITY = 2;

export interface LongRangeBucket {
  // Bucket start (the week's first day / the month's first) — the plotted x.
  date: string;
  // Arithmetic mean of the bucket's readings — the plotted line. NULL for an
  // EMPTY calendar bucket between two occupied ones (#2258): a six-week outage
  // inside a 1Y window must not bridge at bucket grain either, or the day-grain
  // fix is undone one level up. A bucket that summarises nothing has no mean.
  value: number | null;
  // The bucket's spread — the band. lo === hi for a single-reading bucket, and
  // both are null for an empty bucket (there is no spread to draw).
  lo: number | null;
  hi: number | null;
  // How many readings the bucket summarises. Zero for an empty bucket.
  count: number;
}

export interface LongRangeSeries {
  grain: LongRangeGrain;
  points: LongRangeBucket[];
}

// The grain a span of inclusive days plots at; null means raw points.
export function longRangeGrain(spanDays: number): LongRangeGrain | null {
  if (spanDays <= LONG_RANGE_MIN_DAYS) return null;
  return spanDays <= MONTH_GRAIN_MIN_DAYS ? "week" : "month";
}

function bucketStart(
  date: string,
  grain: LongRangeGrain,
  weekStart: number
): string {
  return grain === "week"
    ? startOfWeekStr(date, weekStart)
    : `${date.slice(0, 7)}-01`;
}

// The next calendar bucket start after `date` — +7 days at week grain, the first
// of the following month at month grain. Pure string/UTC arithmetic, matching the
// calendar anchoring `bucketStart` uses.
function nextBucket(date: string, grain: LongRangeGrain): string {
  if (grain === "week") return shiftDateStr(date, 7);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

// Every calendar bucket start from `first` to `last` inclusive. Bounded (a decade
// of months / two decades of weeks) so a pathological pair can never loop away.
function bucketStartsInclusive(
  first: string,
  last: string,
  grain: LongRangeGrain
): string[] {
  const out: string[] = [];
  let b = first;
  for (let i = 0; b <= last && i < 1200; i++) {
    out.push(b);
    b = nextBucket(b, grain);
  }
  return out;
}

// Aggregate a chronological dated series into calendar buckets, or return null
// when the series should plot raw (short span, sparse data, or nothing to plot).
// Null values are chart gaps and never enter a bucket. `weekStart` follows
// lib/date.ts (0=Sunday, the app default).
export function aggregateLongRange(
  points: readonly { date: string; value: number | null }[],
  weekStart = 0
): LongRangeSeries | null {
  const real = points.filter((p): p is { date: string; value: number } => {
    return p.value != null && Number.isFinite(p.value);
  });
  if (real.length === 0) return null;

  const span = daysBetweenDateStr(real[0].date, real[real.length - 1].date);
  if (span == null) return null; // unparseable dates degrade to the raw plot
  const grain = longRangeGrain(span + 1);
  if (grain == null) return null;

  const byBucket = new Map<
    string,
    { sum: number; lo: number; hi: number; count: number }
  >();
  for (const p of real) {
    const key = bucketStart(p.date, grain, weekStart);
    const b = byBucket.get(key);
    if (b) {
      b.sum += p.value;
      b.lo = Math.min(b.lo, p.value);
      b.hi = Math.max(b.hi, p.value);
      b.count += 1;
    } else {
      byBucket.set(key, { sum: p.value, lo: p.value, hi: p.value, count: 1 });
    }
  }

  // The density gate — see the module header. Occupied buckets only: a gapped
  // series is judged on the data it has, not on the calendar it missed. Computed
  // BEFORE the empty buckets below join the output, so densifying the axis can
  // never push a legible sparse series over (or under) the bar.
  if (real.length < byBucket.size * LONG_RANGE_MIN_DENSITY) return null;

  // Emit the CALENDAR, not just the occupied buckets (#2258). Aggregation runs on
  // a category axis exactly like the raw plot does, so an interior run of empty
  // weeks/months would otherwise compress away and a six-week outage inside a 1Y
  // window would bridge at bucket grain — the day-grain fix undone one level up.
  // Leading/trailing empties do not arise: the enumeration is bounded by the first
  // and last OCCUPIED bucket, which is the same trimming rule lib/day-fill.ts
  // applies at the head (the window's trailing tail is already densified into
  // `points` before this runs, so its empty buckets are interior here).
  const occupied = [...byBucket.keys()].sort();
  const axis = bucketStartsInclusive(
    occupied[0],
    occupied[occupied.length - 1],
    grain
  );
  return {
    grain,
    points: axis.map((date) => {
      const b = byBucket.get(date);
      if (!b) return { date, value: null, lo: null, hi: null, count: 0 };
      return {
        date,
        value: b.sum / b.count,
        lo: b.lo,
        hi: b.hi,
        count: b.count,
      };
    }),
  };
}

// The aggregated chart's honesty caption — the line that tells the reader each
// point is a summary, rendered by the chart component under every aggregated
// plot. One string per grain, here, so no surface paraphrases it differently.
export function longRangeCaption(grain: LongRangeGrain): string {
  return grain === "week"
    ? "Weekly averages · band shows each week's low–high"
    : "Monthly averages · band shows each month's low–high";
}

// Fixed-English month table (the app is single-language by design; see
// lib/format-date.ts) for the month-bucket tooltip label.
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

// The tooltip's date label for an aggregated point: a week bucket names its
// start day ("Week of <formatted start>", with the caller supplying the
// pref-formatted date so the tooltip keeps the login's date shape); a month
// bucket names the month itself.
export function longRangeBucketLabel(
  grain: LongRangeGrain,
  bucketDate: string,
  formattedStart: string
): string {
  if (grain === "week") return `Week of ${formattedStart}`;
  const monthIndex = Number(bucketDate.slice(5, 7)) - 1;
  const month = MONTHS_LONG[monthIndex] ?? bucketDate.slice(0, 7);
  return `${month} ${bucketDate.slice(0, 4)}`;
}
