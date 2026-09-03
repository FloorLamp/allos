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
// ONE COMPUTATION, keyed on the SERIES KEY — the same `metric:<id>` / `result:<name>`
// vocabulary the saved store, the compare picker and the tile grid already share
// (lib/saved-items.ts) — so every surface that renders a tile asks this one
// question instead of re-deciding per grid. The mark VARIANT itself lives in the
// #1445 scaffold registry (components/chart-scaffold.tsx); this module owns only
// "which one".

import { daysBetweenDateStr } from "./date";
import type { DayFillWindow, DayGapFill, DaySeriesPoint } from "./day-fill";
import { fillDailyRows, fillDailySeries } from "./day-fill";
import type { DaySourceSpread } from "./metric-sources";

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
 * `"result:LDL Cholesterol"`). A biomarker is always a level — an analyte has a value
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
// here, once per series, on the same `metric:` / `result:` vocabulary — because it is
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
//   • "bridge-with-limit" — a LEVEL that stops being one across a long enough
//     silence (#2653 state 3). The daily check-in ratings: how you felt existed
//     on the days you did not rate it, so a skipped day bridges — but a stroke
//     drawn across four unlogged days is describing a mood nobody was there for.
//     Past the series' declared gap limit the stroke BREAKS and the hole is
//     labelled. Deliberately OPT-IN and a value of its own rather than a
//     threshold quietly bolted onto "bridge" (owner call 2, 2026-08-13): a
//     declared policy is never silently changed, so a series that wants
//     hole-past-threshold behaviour says so by name.
//   • "exempt" — no densification at all. Every `result:` series: lab draws are
//     sparse BY NATURE, and expanding a 1-year window around three draws into 365
//     mostly-null categories degrades the tile for no honesty gain (the biomarker
//     DETAIL chart already answers the spacing question properly, on a numeric
//     time axis — lib/chart-time-axis.ts).
//
// Note what "slot" does NOT mean: it is the FILL, not the mark. Steps is a total
// that still draws as a line; `sparklineShapeForMetric` remains the only thing
// that decides bars.

export type SeriesGap =
  | "bridge"
  | "bridge-with-limit"
  | "break"
  | "slot-zero"
  | "slot-null"
  | "exempt";

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
  //
  // They are the series that OPT IN to a limit (#2653 state 3): a skipped Tuesday
  // is still a mood you had, a skipped week is not something the stroke may
  // describe. Short holes bridge exactly as before; only a run past
  // `METRIC_GAP_LIMIT_DAYS` breaks, and it says how long it was.
  mood: "bridge-with-limit",
  energy: "bridge-with-limit",
  calm: "bridge-with-limit",

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
 * The gap policy for any trend series, by its full key. `result:` is exempt (see the
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
    case "bridge-with-limit":
    case "break":
    case "slot-null":
      return "null";
    case "slot-zero":
      return "zero";
    case "exempt":
      return null;
  }
}

/**
 * Whether the mark bridges a null hole (`connectNulls`). Only a LEVEL does.
 *
 * "bridge-with-limit" bridges too — the LIMIT is not expressible as this flag
 * (recharts' `connectNulls` is all-or-nothing), so the over-limit holes are cut
 * out of the plotted series instead and each surviving run is drawn bridged. See
 * `overLimitHoles`.
 */
export function gapBridgesNulls(gap: SeriesGap): boolean {
  return gap === "bridge" || gap === "bridge-with-limit";
}

/** Whether an over-limit hole BREAKS this series' stroke, rather than only being
 *  named. Opt-in per owner call 2 — a declared bridge is never silently cut. */
export function gapBreaksPastLimit(gap: SeriesGap): boolean {
  return gap === "bridge-with-limit";
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
// same `metric:` / `result:` vocabulary, because it is a property of the QUANTITY and
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
 *  than observed. Open vocabulary (`result:<name>`), so one number for the
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
  if (key.startsWith("result:")) return BIO_CONTINUITY_DAYS;
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
  points: readonly DaySeriesPoint[],
  spec: DayFillSpec | null | undefined
): {
  data: DaySeriesPoint[];
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

// ── The GAP LIMIT (issue #2653, states 2, 3 and 4) ──────────────────────────
//
// THE DEFECT, twice. A bridge-declared series (mood, energy, calm) draws one
// unbroken stroke straight across a four-day outage — a trajectory through days
// nobody logged. And at the other end of the same series, day-fill correctly
// keeps the trailing hole, so the line stops short of the axis edge and says
// nothing at all about why. Two renders, one missing fact: THIS SERIES WAS
// SILENT FOR A WHILE, and the chart knows exactly how long.
//
// THE DECLARATION, in the same shape as the gap and the continuity span: one
// number per series, on the same `metric:` / `result:` vocabulary, because how long
// a silence has to run before it is worth naming is a property of the QUANTITY.
// A daily check-in going quiet for three days is news; a tape measure going quiet
// for three days is a Tuesday.
//
// WHY NOT REUSE `METRIC_CONTINUITY_DAYS`. That answers "across what interval is
// the stroke still a fair interpolation" — a question about the WHOLE series'
// cadence, evaluated on the median. This one is about ONE hole. The relation is
// an INVARIANT rather than an equality: a hole longer than the continuity span
// must always be named, so every limit here sits at or below that metric's span,
// and `lib/__tests__/chart-gap-limit.test.ts` pins it in both directions.
//
// WHAT THE LIMIT DOES NOT DO. It never changes a declared bridge. Only a series
// that declared "bridge-with-limit" has its stroke cut (owner call 2); for every
// other policy the over-limit hole is LABELLED and the stroke behaves exactly as
// it did. Naming a hole the chart already draws is not a policy change.
//
// THE TIERS, named for how the reading arrives — the same discipline the two
// registries above use.

/** Arrives every day something is worn or a check-in is tapped. Miss one, miss
 *  two; a third consecutive silent day is the stream stopping. */
const STREAM_GAP_LIMIT = 2;

/**
 * Accrues from SESSIONS the user logs, not from a device reporting. A day with
 * no session is the ordinary texture of the series rather than a reporting
 * failure, so the silence worth naming is a whole week of them.
 *
 * WHY IT IS NOT `STREAM_GAP_LIMIT` (#2871, owner amendment on #2830). The stream
 * tier answers "the device went quiet", and three silent days there genuinely is
 * three silent days. Asked of a hand-logged series the same integer answers a
 * different question, and answers it wrongly: at 2, an ordinary outdoor-time
 * rhythm shattered a 77-day window into eleven grey bands.
 *
 * WHY IT IS NOT `ACUTE_GAP_LIMIT`, which happens to hold the same integer today:
 * the tiers are named for how the reading ARRIVES, and these two arrive for
 * unrelated reasons. Retuning one must not silently move the other.
 */
const SESSION_GAP_LIMIT = 7;

/** Taken because of a question being asked that day. A week without one is not a
 *  lapse — the question stopped being asked. */
const ACUTE_GAP_LIMIT = 7;

/** A scale step-on or a tape measure. A fortnight between two is an ordinary
 *  habit; three weeks is a habit that stopped. */
const HABIT_GAP_LIMIT = 21;

/** Picked up when there is a reason. Months apart is the legitimate cadence, so
 *  only a third of a year of silence is worth a word. */
const EPISODIC_GAP_LIMIT = 120;

/** A body attribute that moves over seasons. A year. */
const SLOW_GAP_LIMIT = 365;

/** A lab draw. The same span its stroke may cross — for an open vocabulary one
 *  number serves the namespace. */
export const BIO_GAP_LIMIT_DAYS = 540;

/**
 * The longest run of unlogged days this series may carry without saying so.
 * EXHAUSTIVE over the same vocabulary as `METRIC_GAP` and
 * `METRIC_CONTINUITY_DAYS` — the completeness test fails a key present in one
 * registry and absent from another, in every direction, so the three cannot
 * drift apart.
 */
export const METRIC_GAP_LIMIT_DAYS: Readonly<Record<string, number>> = {
  // ── levels ────────────────────────────────────────────────────────────────
  weight: HABIT_GAP_LIMIT,
  bodyfat: HABIT_GAP_LIMIT,
  bmi: HABIT_GAP_LIMIT,
  "lean-mass": HABIT_GAP_LIMIT,
  "bone-mass": HABIT_GAP_LIMIT,
  bmr: HABIT_GAP_LIMIT,
  "waist-circ": HABIT_GAP_LIMIT,
  hydration: STREAM_GAP_LIMIT,
  resting_hr: STREAM_GAP_LIMIT,
  hrv: STREAM_GAP_LIMIT,
  "skin-temp": STREAM_GAP_LIMIT,
  hr: STREAM_GAP_LIMIT,
  "peak-flow": STREAM_GAP_LIMIT,
  height: SLOW_GAP_LIMIT,
  "head-circ": SLOW_GAP_LIMIT,
  systolic: EPISODIC_GAP_LIMIT,
  diastolic: EPISODIC_GAP_LIMIT,
  spo2: EPISODIC_GAP_LIMIT,
  "respiratory-rate": EPISODIC_GAP_LIMIT,
  temperature: ACUTE_GAP_LIMIT,
  mood: STREAM_GAP_LIMIT,
  energy: STREAM_GAP_LIMIT,
  calm: STREAM_GAP_LIMIT,

  // ── per-day totals ────────────────────────────────────────────────────────
  //
  // The tier each of these sits on is decided by WHERE THE DAY'S TOTAL COMES
  // FROM, and this block is the one place the two answers sit side by side
  // (#2871 asked for the whole block to be checked rather than `sun` alone):
  //
  //   - `volume` — a workout's tonnage, but declared `slot-zero`: a rest day is
  //     a real zero, so a densified day is never null and this series has no
  //     holes to name at any limit. Its integer is inert either way.
  //   - `steps` / `active-calories` — a worn device's daily total. Device-
  //     reported, so STREAM stands (#2830's ruling, unamended for these).
  //   - `sun` — daylight minutes from LOGGED outdoor sessions. The metric the
  //     owner's amendment moves.
  //   - `calories` — intake, which also accrues from what the user logs. Left on
  //     STREAM deliberately: the amendment sanctions `sun` and nothing wider, and
  //     whether food logging reads as a session is a calibration question for the
  //     owner rather than one to answer in passing here.
  volume: STREAM_GAP_LIMIT,
  steps: STREAM_GAP_LIMIT,
  "active-calories": STREAM_GAP_LIMIT,
  sun: SESSION_GAP_LIMIT,
  calories: STREAM_GAP_LIMIT,

  // ── render-only series ────────────────────────────────────────────────────
  "sleep-duration": STREAM_GAP_LIMIT,
  "sleep-stages": STREAM_GAP_LIMIT,
  "sleep-regularity": STREAM_GAP_LIMIT,
  "oura-score": STREAM_GAP_LIMIT,
  macros: STREAM_GAP_LIMIT,
};

/**
 * The gap limit for any trend series, or null when the series declares none.
 * Null means "say nothing", the safe answer: naming a silence on a series whose
 * grain we cannot name is how a per-event axis would acquire a caption about days
 * it does not plot.
 */
export function gapLimitDaysForSeriesKey(key: string): number | null {
  if (key.startsWith("result:")) return BIO_GAP_LIMIT_DAYS;
  const prefix = "metric:";
  if (!key.startsWith(prefix)) return null;
  return METRIC_GAP_LIMIT_DAYS[key.slice(prefix.length)] ?? null;
}

/** A run of unlogged days long enough to be worth naming. */
export interface SeriesHole {
  /** First unlogged day. */
  from: string;
  /** Last unlogged day. */
  to: string;
  /** Unlogged days, inclusive of both ends. */
  days: number;
  /** Whether the run reaches the end of the plotted window — a LIVE outage
   *  (#2653 state 4) rather than a closed one the series recovered from. */
  trailing: boolean;
}

/**
 * The runs of unlogged days in a DENSIFIED series that exceed `limitDays`.
 *
 * Densified: every calendar day in the window is a row, which is what makes a run
 * of nulls a count of days rather than a count of missing rows. Asking this of a
 * raw series would report one "hole" per unsampled interval on every level chart
 * in the app.
 *
 * A LEADING run — nulls before the first real reading — is never a hole. The
 * series had not started; an axis that begins before the data is not a silence,
 * and calling it one would put "43 days unlogged" on the left edge of every chart
 * whose window opens before its first reading.
 */
export function overLimitHoles(
  points: readonly { date: string; value: number | null }[],
  limitDays: number | null
): SeriesHole[] {
  if (limitDays == null) return [];
  const holes: SeriesHole[] = [];
  let started = false;
  let runStart = -1;
  const flush = (endIndex: number, trailing: boolean) => {
    if (runStart < 0) return;
    const days = endIndex - runStart + 1;
    if (days > limitDays) {
      holes.push({
        from: points[runStart].date,
        to: points[endIndex].date,
        days,
        trailing,
      });
    }
    runStart = -1;
  };
  for (let i = 0; i < points.length; i++) {
    if (points[i].value == null) {
      if (!started) continue;
      if (runStart < 0) runStart = i;
      continue;
    }
    flush(i - 1, false);
    started = true;
  }
  flush(points.length - 1, true);
  return holes;
}

/**
 * The plotted readings NO STROKE REACHES, by index (#4924).
 *
 * THE DEFECT. Three shipped rules compounded on the Active Calories card. Its
 * `slot-null` policy breaks the stroke at every null day, so only calendar-
 * adjacent readings join. Resting dots turn off above `DENSE_SERIES_POINTS`,
 * fed the window's REAL reading count. And the sparse demotion judges the MEDIAN
 * interval, which a densely-logged June keeps at 1. So an August reading with no
 * neighbour had no segment and no dot: it existed only on hover, under a caption
 * saying "No data since Aug 30" over a plot that visibly ended on Jul 27.
 *
 * A clutter threshold was deciding for a reading whose MARK is its only
 * representation. This is the predicate that separates the two: a reading the
 * stroke already draws may be thinned out of the dot layer, and a reading the
 * stroke cannot reach may not.
 *
 * Read off the render topology rather than re-derived from the policy, so the
 * answer cannot disagree with what was drawn:
 *   • cut into RUNS (an over-limit hole broke the stroke) — a run holding one
 *     reading draws no segment, so that reading is isolated;
 *   • one BRIDGED line — every reading joins every other, so only a series of
 *     one is isolated (and that one already has `loneReading`'s own mark);
 *   • one UNBRIDGED line — a reading joins only a calendar neighbour.
 */
export function isolatedReadings(
  values: readonly (number | null)[],
  { bridged, runs }: { bridged: boolean; runs?: readonly (readonly number[])[] }
): Set<number> {
  const real = (i: number) => values[i] != null;
  const out = new Set<number>();
  if (runs != null && runs.length > 1) {
    for (const [from, to] of runs) {
      let only = -1;
      let count = 0;
      for (let i = from; i <= to && count < 2; i++) {
        if (real(i)) {
          only = i;
          count++;
        }
      }
      if (count === 1) out.add(only);
    }
    return out;
  }
  if (bridged) {
    const drawn = values.reduce<number[]>(
      (acc, v, i) => (v == null ? acc : [...acc, i]),
      []
    );
    if (drawn.length === 1) out.add(drawn[0]);
    return out;
  }
  values.forEach((v, i) => {
    if (v != null && !real(i - 1) && !real(i + 1)) out.add(i);
  });
  return out;
}

/**
 * The label inside an interior hole: "4 days unlogged".
 *
 * RAW FACT ONLY — a count and the plainest word for what did not happen. Not
 * "data gap", not "missing data", and no adjective: the label exists so a reader
 * can price the break in the stroke, and a chart that editorialises about its own
 * absence reads as more considered than the confident line it replaced.
 */
export function unloggedGapLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"} unlogged`;
}

/**
 * The caption under a chart whose series is STILL silent: "No data since Aug 8".
 *
 * The date arrives already formatted, so the caller's format preferences decide
 * how a day is written and this module never grows a second date style. The
 * caller pairs it with the route to the diagnosis (#2146 owns the quiet-stream
 * verdict; this annotation only explains a gap the chart already draws).
 */
export function trailingOutageCaption(lastReadingLabel: string): string {
  return `No data since ${lastReadingLabel}`;
}

// ── TWO SOURCES, ONE DAY: what earns a companion mark (#2653 state 6) ─────────
//
// The read reports every source a day's election set aside (lib/metric-sources);
// the chart draws a companion only where the other source would PRINT A DIFFERENT
// NUMBER at the chart's own precision. Two scales agreeing to the digit a reader
// can see is not a disagreement — a second mark there is the coincident smudge the
// issue opened with, ink with no fact. Deciding on the printed string is also what
// keeps the marks and the caption counting the same days.
export function sourceSpreadCompanions(
  points: readonly {
    date: string;
    value: number | null;
    sources?: DaySourceSpread;
  }[],
  print: (value: number) => string | number
): Map<string, DaySourceSpread> {
  const out = new Map<string, DaySourceSpread>();
  for (const point of points) {
    if (point.sources == null || point.value == null) continue;
    const shown = print(point.value);
    const others = point.sources.others.filter(
      (other) => print(other.value) !== shown
    );
    if (others.length > 0) {
      out.set(point.date, { trusted: point.sources.trusted, others });
    }
  }
  return out;
}

/** "Oura", "Oura and Withings", "Oura, Withings and Manual". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The caption under a plot with companion marks: "Showing Withings · 2 days also
// reported by Oura". Facts in the register of the other honesty captions — which
// source is plotted, how many days another one also covered, and who — and no word
// for the disagreement: which number is right is not something the chart knows;
// choosing lives in the primary-source picker.
export function sourceSpreadCaption(
  spreads: ReadonlyMap<string, DaySourceSpread>
): string {
  const trusted = [...new Set([...spreads.values()].map((s) => s.trusted))];
  const others = [
    ...new Set(
      [...spreads.values()].flatMap((s) => s.others.map((o) => o.source))
    ),
  ];
  const days = spreads.size;
  return `Showing ${nameList(trusted)} · ${days} day${days === 1 ? "" : "s"} also reported by ${nameList(others)}`;
}
