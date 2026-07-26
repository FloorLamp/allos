// Which MARK a trend tile's sparkline draws (issue #1485 D).
//
// A line implies continuity: it says "the quantity existed between these two
// readings and moved smoothly from one to the other". That is true of weight,
// resting HR and every biomarker — the analyte has a value on the days you didn't
// measure it, you simply didn't sample it. It is NOT true of training volume: the
// series is a per-day TOTAL that is genuinely zero on a rest day, so joining
// Monday's 8,000 kg to Wednesday's 7,000 kg draws a slope through a day that had
// no training in it at all. At tile width the result is a sawtooth that reads as
// noise rather than as "trained Mon/Wed/Fri".
//
// Bars say the true thing: each day is its own quantity, and the gaps are the rest
// days. Same data, same window, a mark that matches the job.
//
// ONE COMPUTATION, keyed on the SERIES KEY — the same `metric:<id>` / `bio:<name>`
// vocabulary the saved store, the compare picker and the tile grid already share
// (lib/saved-items.ts) — so every surface that renders a tile asks this one
// question instead of re-deciding per grid. The mark VARIANT itself lives in the
// #1445 scaffold registry (components/chart-scaffold.tsx); this module owns only
// "which one".

export type SparklineShape = "line" | "bar";

// The metric ids whose series is a per-period QUANTITY rather than a level: zero
// on a day the thing didn't happen, and meaningful only as a per-day total.
//
// Deliberately a short, justified list rather than a heuristic over the data — a
// runtime "does it oscillate?" test would flip a tile's mark between windows, and
// a mark that changes shape as you move the range is worse than one that is
// occasionally conservative. A new metric joins by NAME, with the reason.
const BAR_SHAPED_METRICS: readonly string[] = [
  // Per-session tonnage, summed per day; a rest day is a real zero.
  "volume",
];

/** The mark for a metric tile, by its `metric:` id (`"volume"`). */
export function sparklineShapeForMetric(id: string): SparklineShape {
  return BAR_SHAPED_METRICS.includes(id) ? "bar" : "line";
}

/**
 * The mark for any trend series, by its full key (`"metric:volume"`,
 * `"bio:LDL Cholesterol"`). A biomarker is always a level — an analyte has a value
 * on the days between draws — so it is always a line; an unrecognized key falls
 * back to the line too, which is the safe default (a level drawn as bars merely
 * looks odd; a quantity drawn as a line asserts something false).
 */
export function sparklineShapeForSeriesKey(key: string): SparklineShape {
  const prefix = "metric:";
  if (!key.startsWith(prefix)) return "line";
  return sparklineShapeForMetric(key.slice(prefix.length));
}
