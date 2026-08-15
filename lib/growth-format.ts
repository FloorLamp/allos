// Pure display helpers for growth percentiles (no DB, no React) — unit-tested in
// lib/__tests__/growth-format.test.ts.

// Format a 0–100 percentile as an ordinal for display ("40th", "3rd", "97th").
// Rounds to the nearest whole percentile and clamps the extremes to "<1st"/">99th"
// so a z-score deep in the tail never renders as "0th" or "100th".
export function ordinalPercentile(percentile: number): string {
  if (percentile < 1) return "<1st";
  if (percentile > 99) return ">99th";
  const n = Math.round(percentile);
  return `${n}${ordinalSuffix(n)}`;
}

// THE GROWTH CHART'S TOOLTIP ROWS (#2804).
//
// The chart plots each reference band under the dataKey `p3`…`p97` and the child's
// own trajectory under `traj`. Both halves of a tooltip row — what it says and where
// it sits — are decided from that key, and both used to be wrong: the label was a
// hardcoded `${key without the p}th pct`, so the 3rd percentile read "3th"; and the
// ORDER came from recharts 3's default `itemSorter: 'name'`, which lexically sorts
// the payload before any formatter runs (10th, 25th, 3th, 5th, 50th…). Pure and here
// rather than inline in the chart so the two stay one decision and are testable.

/** The percentile a band's dataKey names — `p3` → 3. NaN for the trajectory key. */
export function bandPercentileFromKey(dataKey: unknown): number {
  return Number(String(dataKey).slice(1));
}

/** The tooltip row's label: the child's own reading, or an ordinal band. */
export function growthTooltipLabel(dataKey: unknown): string {
  if (dataKey === TRAJECTORY_KEY) return "This profile";
  return `${ordinalPercentile(bandPercentileFromKey(dataKey))} pct`;
}

/** Sort key for the tooltip rows: the child's own reading first, then the bands
 *  low→high. Numeric, which is neither recharts' lexical default nor the render
 *  order the shared tooltip props ask for (the trajectory is drawn LAST so it sits
 *  on top of the bands). */
export function growthTooltipOrder(dataKey: unknown): number {
  return dataKey === TRAJECTORY_KEY ? -1 : bandPercentileFromKey(dataKey);
}

/** The dataKey the profile's own trajectory is plotted under. */
export const TRAJECTORY_KEY = "traj";

function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
