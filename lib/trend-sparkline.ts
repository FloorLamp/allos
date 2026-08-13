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

import { daysBetweenDateStr } from "./date";
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

/**
 * The ONE point a windowed series has, or null when it has none or more than one
 * (#2615 item 3).
 *
 * A line needs two points to describe a direction, so a series with exactly one gets a
 * MARKER, not a plot: the tile grammar has drawn it that way since #1485 G ("Single
 * reading · Jul 13"), while the full chart cards kept plotting it — a 30-day band, empty
 * apart from one dot half-clipped against the y-axis, which reads as a rendering failure
 * rather than as "there is one reading here". Same data, same window, the honest mark.
 *
 * Counted over NON-NULL values: a densified series (#2258) is mostly holes by
 * construction, so the number of days the window happens to span says nothing about how
 * many readings are in it.
 */
export function loneReading<T extends { value: number | null }>(
  data: readonly T[]
): T | null {
  let found: T | null = null;
  for (const point of data) {
    if (point.value == null) continue;
    if (found != null) return null;
    found = point;
  }
  return found;
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
// exactly how the body census, the tile grid and the detail page would come to
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
 * savable metric id (`savedMetricIdForTrendSlug` over every registered body slug,
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
  // Waist circumference is a level too (#2322): your waist has a value on the days
  // between tape measurements, so the stroke may cross the hole and densification
  // buys honest calendar spacing between two measurements a month apart.
  "waist-circ": "bridge",
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

// ── The DENSITY floor (issue #2653, state 5) ────────────────────────────────
//
// THE DEFECT. Three readings spread over three years plot as a confident 2px
// stroke — the same stroke a series measured every morning gets. A line is an
// assertion about the space BETWEEN its points, and at that spacing almost all of
// the ink is assertion: the reader is looking at a drawing of two interpolations
// and three facts, with nothing distinguishing them.
//
// THE DECISION, in the same shape as the gap above: one number per series, on the
// same `metric:` / `bio:` vocabulary, because it is a property of the QUANTITY and
// not of the surface drawing it. `CONTINUITY_DAYS` is the longest interval between
// two consecutive readings across which this quantity's stroke is still a fair
// interpolation. Past it, the presentation demotes (see chart-scaffold's
// `chartSparse*`): the DOTS lead, the connecting stroke becomes a faint dashed
// hint, and the plot carries a caption stating the raw count and span.
//
// WHY THE MEDIAN INTERVAL AND NOT A RATE. "Readings per year" cannot tell a sparse
// series from a dense one with an outage: thirty daily weigh-ins followed by three
// years of silence average out to the same rate as three readings evenly spread,
// and only the second is sparse. The first is an OUTAGE, which day-fill's kept
// trailing holes and the interior-gap treatment answer — a different state of this
// issue, and it must not be relabelled as this one. The MEDIAN interval says so
// directly: one enormous gap does not move it, and a genuinely thin series has
// nothing but enormous gaps.
//
// WHY NOT REUSE THE PRESENTATION FLOOR. `TREND_METRIC_PRESENTATION_FLOORS` (#2671)
// answers a different question — how old the LATEST reading may be before the
// headline stops being a claim about now. This one is about the space between two
// readings, wherever they sit. The two are related, and the relation is an
// INVARIANT rather than an equality: a series may never be called sparse while its
// own latest reading would still be presented as current, so every span here is at
// or above that metric's floor. `lib/__tests__/sparse-series.test.ts` pins it, so
// the two registries are provably consistent instead of merely coexisting.
//
// THE TIERS, named for how the reading ARRIVES — the same discipline the floors
// registry uses, so 27 metrics declare a cadence rather than 27 loose integers.

/** Arrives every day something is worn or a check-in is tapped. A fortnight
 *  between two of them means the stream stopped, not that it moved smoothly. */
const STREAM_CONTINUITY = 14;

/** Taken because of a question being asked that day — a thermometer. A month
 *  apart, the stroke draws a fever curve nobody measured. */
const ACUTE_CONTINUITY = 30;

/** A scale step-on or a tape measure: done when you think of it. Monthly-ish
 *  with skipped months is an ordinary habit; two measurements a season apart
 *  are two facts, not a trajectory. */
const HABIT_CONTINUITY = 60;

/** Picked up when there is a reason — a cuff before an appointment, an
 *  oximeter while unwell. Months apart is the legitimate cadence; a year is
 *  not a line. */
const EPISODIC_CONTINUITY = 365;

/** A body attribute that moves over seasons and years. */
const SLOW_CONTINUITY = 730;

/** A lab draw. An annual-to-semiannual panel is the ordinary cadence, so the
 *  stroke is fair across it; past ~18 months it spans more unobserved time
 *  than observed. Open vocabulary (`bio:<name>`), so one number for the
 *  namespace rather than a row per analyte. */
export const BIO_CONTINUITY_DAYS = 540;

/**
 * The continuity span per `metric:` id. EXHAUSTIVE over the same vocabulary as
 * `METRIC_GAP` — `lib/__tests__/sparse-series.test.ts` fails a key that is in one
 * registry and not the other, in both directions, so the two cannot drift apart.
 */
export const METRIC_CONTINUITY_DAYS: Readonly<Record<string, number>> = {
  // ── levels ────────────────────────────────────────────────────────────────
  weight: HABIT_CONTINUITY,
  bodyfat: HABIT_CONTINUITY,
  bmi: HABIT_CONTINUITY,
  "lean-mass": HABIT_CONTINUITY,
  "bone-mass": HABIT_CONTINUITY,
  bmr: HABIT_CONTINUITY,
  "waist-circ": HABIT_CONTINUITY,
  hydration: STREAM_CONTINUITY,
  resting_hr: STREAM_CONTINUITY,
  hrv: STREAM_CONTINUITY,
  "skin-temp": STREAM_CONTINUITY,
  hr: STREAM_CONTINUITY,
  "peak-flow": STREAM_CONTINUITY,
  height: SLOW_CONTINUITY,
  "head-circ": SLOW_CONTINUITY,
  systolic: EPISODIC_CONTINUITY,
  diastolic: EPISODIC_CONTINUITY,
  spo2: EPISODIC_CONTINUITY,
  "respiratory-rate": EPISODIC_CONTINUITY,
  temperature: ACUTE_CONTINUITY,
  mood: STREAM_CONTINUITY,
  energy: STREAM_CONTINUITY,
  calm: STREAM_CONTINUITY,

  // ── per-day totals ────────────────────────────────────────────────────────
  // A total arrives on the day it happened or not at all, so its cadence is the
  // stream's. Training volume is drawn as BARS, which assert nothing between
  // columns — it declares a span anyway so the registry stays total, and the
  // demotion simply never reaches it.
  volume: STREAM_CONTINUITY,
  steps: STREAM_CONTINUITY,
  "active-calories": STREAM_CONTINUITY,
  sun: STREAM_CONTINUITY,
  calories: STREAM_CONTINUITY,

  // ── render-only series ────────────────────────────────────────────────────
  "sleep-duration": STREAM_CONTINUITY,
  "sleep-stages": STREAM_CONTINUITY,
  "sleep-regularity": STREAM_CONTINUITY,
  "oura-score": STREAM_CONTINUITY,
  macros: STREAM_CONTINUITY,
};

/**
 * The continuity span for any trend series, or null when the series declares
 * none. Null is the SAFE answer and means "draw it exactly as before": an
 * unregistered id and an unknown namespace both take it, because demoting a
 * stroke whose grain we cannot name is how a per-event axis would acquire a
 * caption about days it does not plot.
 */
export function continuityDaysForSeriesKey(key: string): number | null {
  if (key.startsWith("bio:")) return BIO_CONTINUITY_DAYS;
  const prefix = "metric:";
  if (!key.startsWith(prefix)) return null;
  return METRIC_CONTINUITY_DAYS[key.slice(prefix.length)] ?? null;
}

/**
 * The median number of days between consecutive dated readings, or null when
 * there are fewer than two datable ones. Dates need not arrive sorted. An even
 * count takes the lower of the two middle intervals — a whole number of days
 * reads better in the reason a test prints, and half a day never changes a
 * verdict against spans measured in weeks.
 */
export function medianIntervalDays(dates: readonly string[]): number | null {
  const sorted = [...dates].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = daysBetweenDateStr(sorted[i - 1], sorted[i]);
    if (d == null) continue;
    gaps.push(d);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor((gaps.length - 1) / 2)];
}

/** A series too thin for its stroke to be a fair interpolation. */
export interface SparseSeriesVerdict {
  /** REAL readings — never densified calendar days. */
  readings: number;
  /** Inclusive days from the first real reading to the last. */
  spanDays: number;
  /** The median interval that crossed the declared span. */
  medianGapDays: number;
  /** The series' declared continuity span, for the reason a caller may print. */
  continuityDays: number;
}

/**
 * Whether this series' stroke over-claims, and the facts a caption may state.
 * Null means "draw it as before" — the default, and what every unrecognised
 * series gets.
 *
 * Counted over NON-NULL values, on the series BEFORE densification: a filled
 * calendar day is not a reading, and a `slot-zero` fill writes real zeros that
 * would otherwise read as daily measurement.
 *
 * Fewer than two readings is not sparse: one reading draws no line at all (it
 * has its own mark — `loneReading`), and none draws no chart.
 */
export function sparseSeriesVerdict(
  seriesKey: string,
  points: readonly { date: string; value: number | null }[]
): SparseSeriesVerdict | null {
  const continuityDays = continuityDaysForSeriesKey(seriesKey);
  if (continuityDays == null) return null;
  const dates = points.filter((p) => p.value != null).map((p) => p.date);
  if (dates.length < 2) return null;
  const medianGapDays = medianIntervalDays(dates);
  if (medianGapDays == null || medianGapDays <= continuityDays) return null;
  const sorted = [...dates].sort();
  const span = daysBetweenDateStr(sorted[0], sorted[sorted.length - 1]);
  if (span == null) return null;
  return {
    readings: dates.length,
    spanDays: span + 1,
    medianGapDays,
    continuityDays,
  };
}

// The caption's span phrase. Days below a couple of months, then months, then
// years — the coarsest unit that still distinguishes this window from the next
// one. Rounded on purpose: the caption exists to make a THIN series read as thin,
// and "3 readings in 1,043 days" spends precision on the half of the sentence
// that does not carry the point.
function spanPhrase(spanDays: number): string {
  if (spanDays < 60) return `${spanDays} day${spanDays === 1 ? "" : "s"}`;
  if (spanDays < 545) {
    const months = Math.max(2, Math.round(spanDays / 30.44));
    return `${months} months`;
  }
  const years = Math.max(2, Math.round(spanDays / 365.25));
  return `${years} years`;
}

/**
 * The caption a demoted plot carries: "3 readings in 3 years".
 *
 * RAW FACTS ONLY — a count and a span, no adjective, no verdict word, no badge.
 * The caption's job is to let a reader price the stroke they are looking at, and
 * a chart that announces "sparse" in a tasteful chip reads as MORE considered
 * than the confident line it replaced, which is precisely the failure this state
 * is trying to avoid.
 */
export function sparseSeriesCaption(verdict: SparseSeriesVerdict): string {
  return `${verdict.readings} readings in ${spanPhrase(verdict.spanDays)}`;
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
