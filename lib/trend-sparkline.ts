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

import type { DayFillWindow, DayGapFill } from "./day-fill";
import { fillDailyRows, fillDailySeries } from "./day-fill";

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

// ── The GAP declaration (issue #2258) ───────────────────────────────────────
//
// The MARK follows the data (above); so does the GAP. A day-precision series
// plotted on a recharts CATEGORY axis positions x by array INDEX, so a day with no
// row is not on the axis at all and a multi-day outage COMPRESSES AWAY — four
// missed nights render identically to four consecutive ones. `lib/day-fill.ts`
// densifies the series to the calendar; what a densified day CARRIES is decided
// here, once per series, on the same `metric:` / `bio:` vocabulary — because it is
// a property of the QUANTITY, not of the surface drawing it. A per-surface prop is
// exactly how the Body tab, the tile grid and the detail page would come to
// disagree about whether a missing steps day is a zero.
//
// Four policies plus an exemption:
//
//   • "bridge" — a LEVEL. Weight, body fat, BMI, lean/bone mass, BMR, hydration,
//     resting HR, HRV, skin-temp delta, daily average HR, blood pressure, SpO₂,
//     respiratory rate, temperature, peak flow, the daily check-in ratings. The
//     quantity HAS a value on the days you didn't sample it — you simply didn't
//     sample it — so the stroke may cross the hole. What densification buys a
//     level is honest calendar-PROPORTIONAL spacing: two weigh-ins a month apart
//     stop rendering adjacent.
//   • "break" — a per-night / per-day READING. Sleep duration, sleep stages, the
//     sleep-regularity index, the Oura scores. A missed night is a real absence,
//     not an unsampled level, so the stroke breaks across it and the outage is
//     visible as a hole with real width.
//   • "slot-zero" — a per-day TOTAL whose missing day is a REAL ZERO. Training
//     volume: a rest day genuinely produced no tonnage, the same semantics the
//     weekly cardio fill has shipped since #406.
//   • "slot-null" — a per-day TOTAL that was NOT MEASURED. Steps and active
//     calories (a sensor outage is "not measured", never "walked zero steps"), sun
//     minutes, intake calories, and the manually-logged nutrition totals
//     (macros/fiber/protein): a day with no food logs means "didn't log", and a
//     zero there would assert a fast nobody recorded. A total is not a level, so
//     it does not bridge either.
//   • "exempt" — no densification at all. Every `bio:` series: lab draws are
//     sparse BY NATURE, and expanding a 1-year window around three draws into 365
//     mostly-null categories degrades the tile for no honesty gain (the biomarker
//     DETAIL chart already answers the spacing question properly, on a numeric
//     time axis — lib/chart-time-axis.ts).
//
// Note what "slot" does NOT mean: it is the FILL, not the mark. Steps is a total
// that still draws as a line; `sparklineShapeForMetric` remains the only thing
// that decides bars.

export type SeriesGap =
  "bridge" | "break" | "slot-zero" | "slot-null" | "exempt";

/** Both halves of the series-render decision, for a caller that needs each. */
export interface SeriesRender {
  shape: SparklineShape;
  gap: SeriesGap;
}

// Series keys that are RENDER-ONLY: they name a plotted quantity for this registry
// but are not savable trend metrics (they have no tile, no ★, no saved_items row).
// They exist so the sleep and nutrition surfaces declare their gap policy in the
// same vocabulary as every other series instead of passing a policy by hand.
export const SLEEP_DURATION_SERIES_KEY = "metric:sleep-duration";
export const SLEEP_STAGES_SERIES_KEY = "metric:sleep-stages";
export const SLEEP_REGULARITY_SERIES_KEY = "metric:sleep-regularity";
export const OURA_SCORE_SERIES_KEY = "metric:oura-score";
export const MACROS_SERIES_KEY = "metric:macros";

/**
 * The gap policy per `metric:` id. EXHAUSTIVE over the metric vocabulary — every
 * savable metric id (`savedMetricIdForBodySlug` over every registered body slug,
 * plus training volume) and every render-only key above appears exactly once, and
 * `lib/__tests__/day-fill-scan.test.ts` fails the build when a new one does not.
 * A metric joins by NAME with its reason, never by a heuristic over the data:
 * a runtime "does this look like a total?" test would flip a chart's gap semantics
 * between windows, and a series whose holes change meaning as you move the range
 * is worse than one that is occasionally conservative.
 */
export const METRIC_GAP: Readonly<Record<string, SeriesGap>> = {
  // ── levels ────────────────────────────────────────────────────────────────
  weight: "bridge",
  bodyfat: "bridge",
  bmi: "bridge",
  "lean-mass": "bridge",
  "bone-mass": "bridge",
  bmr: "bridge",
  hydration: "bridge",
  resting_hr: "bridge",
  hrv: "bridge",
  "skin-temp": "bridge",
  hr: "bridge",
  height: "bridge",
  "head-circ": "bridge",
  // Clinical vitals are levels too: your blood pressure, oxygen saturation,
  // respiratory rate, temperature and peak flow all exist on the days between
  // readings. Densifying them buys the SPACING (a clinic visit three weeks after
  // the last one stops sitting adjacent to it), not a broken stroke.
  systolic: "bridge",
  diastolic: "bridge",
  spo2: "bridge",
  "respiratory-rate": "bridge",
  temperature: "bridge",
  "peak-flow": "bridge",
  // The 1–5 daily check-in ratings. A level by the same argument — how you felt
  // existed on the days you didn't rate it — and deliberately NOT "break": these
  // series are sparse by nature, and a broken stroke over a 90-day window would
  // leave a tile of disconnected dots where a trajectory used to be.
  mood: "bridge",
  energy: "bridge",
  calm: "bridge",

  // ── per-day totals ────────────────────────────────────────────────────────
  volume: "slot-zero",
  steps: "slot-null",
  "active-calories": "slot-null",
  sun: "slot-null",
  calories: "slot-null",

  // ── render-only series ────────────────────────────────────────────────────
  "sleep-duration": "break",
  "sleep-stages": "break",
  "sleep-regularity": "break",
  "oura-score": "break",
  macros: "slot-null",
};

/** The gap policy for a metric tile, by its `metric:` id (`"steps"`). */
export function seriesGapForMetric(id: string): SeriesGap {
  // An unregistered id bridges: that is today's rendering (a line with
  // `connectNulls`), so an unknown series can only gain calendar spacing, never a
  // silently-invented zero. The completeness test is what keeps this unreachable.
  return METRIC_GAP[id] ?? "bridge";
}

/**
 * The gap policy for any trend series, by its full key. `bio:` is exempt (see the
 * header); an unrecognized namespace is exempt too — densifying a series whose
 * grain we cannot name is how a per-event axis would silently acquire calendar
 * holes.
 */
export function seriesGapForSeriesKey(key: string): SeriesGap {
  const prefix = "metric:";
  if (!key.startsWith(prefix)) return "exempt";
  return seriesGapForMetric(key.slice(prefix.length));
}

/** Both halves at once, for a tile that renders the mark and the gap together. */
export function seriesRenderForSeriesKey(key: string): SeriesRender {
  return {
    shape: sparklineShapeForSeriesKey(key),
    gap: seriesGapForSeriesKey(key),
  };
}

/** What a densified missing day carries, or null when the series is exempt. */
export function gapFillValue(gap: SeriesGap): DayGapFill | null {
  switch (gap) {
    case "bridge":
    case "break":
    case "slot-null":
      return "null";
    case "slot-zero":
      return "zero";
    case "exempt":
      return null;
  }
}

/** Whether the mark bridges a null hole (`connectNulls`). Only a LEVEL does. */
export function gapBridgesNulls(gap: SeriesGap): boolean {
  return gap === "bridge";
}

/**
 * What a chart card is handed to densify itself: WHICH series (so the policy is
 * looked up here, never passed in) and the window it is being plotted against.
 * The card resolves it at/below the render, so a page's `data-points` and its
 * readings table keep counting REAL readings (#2029).
 */
export interface DayFillSpec extends DayFillWindow {
  seriesKey: string;
}

/**
 * Apply a spec to a `{ date, value }` series: the densified array plus the two
 * things the card must not re-derive — whether the mark bridges, and how many REAL
 * readings there are (the dot-density threshold counts readings, never calendar
 * days, or a 90-day window with 12 weigh-ins would silently lose its dots).
 */
export function applyDayFill(
  points: readonly { date: string; value: number | null }[],
  spec: DayFillSpec | null | undefined
): {
  data: { date: string; value: number | null }[];
  bridges: boolean | null;
  realCount: number;
} {
  const realCount = points.reduce((n, p) => (p.value == null ? n : n + 1), 0);
  if (!spec) return { data: [...points], bridges: null, realCount };
  const gap = seriesGapForSeriesKey(spec.seriesKey);
  const fill = gapFillValue(gap);
  if (fill == null) return { data: [...points], bridges: null, realCount };
  return {
    data: fillDailySeries(points, spec, fill),
    bridges: gapBridgesNulls(gap),
    realCount,
  };
}

/**
 * The same decision for a multi-key ROW series (stacked bars: macros, sleep
 * stages). The card supplies the keys its stack draws; a filled day carries the
 * series' fill value under every one of them, so a missing day is an empty slot
 * rather than an absent category.
 */
export function applyDayFillRows<
  T extends { date: string } & Record<string, unknown>,
>(
  rows: readonly T[],
  spec: DayFillSpec | null | undefined,
  keys: readonly string[]
): T[] {
  if (!spec) return [...rows];
  const fill = gapFillValue(seriesGapForSeriesKey(spec.seriesKey));
  if (fill == null) return [...rows];
  const blankValue = fill === "zero" ? 0 : null;
  return fillDailyRows(rows, spec, (date) => {
    const row: Record<string, unknown> = { date };
    for (const k of keys) row[k] = blankValue;
    return row as T;
  });
}
