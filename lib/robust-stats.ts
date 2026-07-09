// Robust (outlier-resistant) statistics for the Trends engines (issue #37). The
// digest and the goal-ETA projection both used to trust every point equally — the
// digest compared the literal first and last reading of a window (one noisy
// endpoint defined the whole "trend"), and the projection fit a plain
// least-squares line (a single spike bent the slope, and two good points plus one
// outlier still produced a confident ETA). These helpers replace those fragile
// summaries with median-based ones: a median endpoint smooths a noisy edge, and a
// Theil–Sen slope (the median of all pairwise slopes) tolerates a minority of bad
// points. Pure math, no dates beyond the shared day-offset helper, exhaustively
// unit-tested in lib/__tests__/robust-stats.
//
// Everything here is O(n²) at worst (the pairwise slopes); the windowed series
// these run over are at most a few hundred points, so that's comfortably cheap.

import { daysBetweenDateStr } from "./date";

// Median of a numeric list. Sorts a copy (never mutates the input) and returns the
// middle element for odd lengths, or the mean of the two middle elements for even
// lengths. Returns NaN for an empty list — callers that can pass empty must guard.
export function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median absolute deviation — a robust analogue of the standard deviation. It's the
// median of the absolute distances of each value from the list's median, so a lone
// outlier moves it far less than it would move a variance. Returns NaN for an empty
// list. (Not scaled by the 1.4826 normal-consistency constant — callers here use
// it only as a relative spread measure, never as a σ estimate.)
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

// A single dated numeric reading. Only `date` (YYYY-MM-DD) and `value` are used;
// callers can pass richer point objects — the extra fields are ignored.
export interface DatedPoint {
  date: string;
  value: number;
}

// Every pairwise slope (value-change per day) between distinct-day point pairs.
// For each pair i<j with a non-zero day gap, (valueⱼ − valueᵢ) / daysBetween. Pairs
// on the same calendar day (zero gap → undefined slope) and any unparseable dates
// are skipped. The Theil–Sen estimate is just the median of this list; the
// projection also inspects its spread to gauge confidence.
export function pairwiseSlopesPerDay(points: readonly DatedPoint[]): number[] {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = daysBetweenDateStr(points[i].date, points[j].date);
      if (dx == null || dx === 0) continue;
      slopes.push((points[j].value - points[i].value) / dx);
    }
  }
  return slopes;
}

// Theil–Sen slope estimator (per day): the median of all pairwise slopes. Far more
// robust than ordinary least squares — up to ~29% of the points can be arbitrary
// outliers before the estimate breaks down, versus a single point being able to
// swing an OLS fit. Returns null when no pair spans any time (all points share a
// day, or fewer than two points), i.e. the slope is undefined.
export function theilSenSlopePerDay(
  points: readonly DatedPoint[]
): number | null {
  const slopes = pairwiseSlopesPerDay(points);
  if (slopes.length === 0) return null;
  return median(slopes);
}

// Robust endpoints of a chronological series: the median of the first `k` values
// and the median of the last `k` values. Using a small cluster at each end instead
// of a single reading keeps one noisy first/last point from defining the whole
// move. `k` is clamped to [1, n]; callers pick it so the two ends don't overlap
// (e.g. k = min(3, floor(n/2))). With k = 1 this is exactly the raw first/last
// values, preserving the pre-#37 behavior for very short series.
export function robustEndpoints(
  points: readonly { value: number }[],
  k: number
): { first: number; last: number } {
  const n = points.length;
  const kk = Math.max(1, Math.min(Math.floor(k), n));
  const firstVals = points.slice(0, kk).map((p) => p.value);
  const lastVals = points.slice(n - kk).map((p) => p.value);
  return { first: median(firstVals), last: median(lastVals) };
}
