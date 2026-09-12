import { BRISTOL_STOOL_METRIC } from "./bristol-stool";
import {
  BREATHING_RATE_METRIC,
  breathingRateSourceRank,
} from "./breathing-rate";

// Instantaneous (point) metrics: a day can hold several readings, so they must be
// averaged per day, not summed. Everything else (steps, distance, calories,
// hydration, nutrition, sleep totals) is genuinely additive. body_fat_pct /
// resting_hr are absent: they now live in body_metrics, not metric_samples.
export const AVERAGED_METRICS = new Set([
  "hrv_ms",
  "lean_mass_kg",
  "muscle_mass_kg",
  "body_water_kg",
  "bone_mass_kg",
  "bmr_kcal",
  "height_cm",
  // Head circumference is a point measure like height: a day holds at most one
  // reading, so a same-date manual entry + imported reading must AVERAGE (agree),
  // never SUM into a doubled value on the growth chart.
  "head_circumference_cm",
  // Skin temperature variation is a signed DELTA from the device's own baseline, so
  // summing is not merely imprecise but meaningless — two +0.3 °C nights would read
  // as +0.6 °C, a deviation neither night had. It is also the one metric here that
  // can be NEGATIVE, which is why it must never reach the additive default.
  "skin_temp_delta_c",
  // Peak expiratory flow (#1850). A flare day holds a morning and an evening blow,
  // and two 300 L/min readings SUMMED would chart a 600 L/min day nobody blew — the
  // most misleading possible number on a surface whose whole job is "is this
  // dropping?". It is a point measure, so the day averages.
  "peak_flow_lmin",
  // Waist circumference (#2322) is a point measure like height: a tape reading and a
  // same-date imported one must AGREE (average), never SUM into a 168 cm waist.
  "waist_circumference_cm",
  // The sleeping breathing rate (#5409) is a point measure, and the reason is ONE
  // SOURCE'S OWN TWO SESSIONS, not two sources.
  //
  // The reason first written here — "two agreeing 13.6s from Health Connect and Fitbit
  // Takeout would sum to 27.2" — was false, and the falsifying pass on PR #5880 is what
  // caught it: two SOURCES never reach the additive default together, because the SUM
  // path elects one of them per day through `pickOneSourcePerDay` / `SOURCE_PREFERENCE`
  // (#14). What does reach it is one source's own two rows in one wake day — a nap and
  // the night, each keyed on its own session start — and 13.6 + 13.6 is the 27.2 br/min
  // night nobody breathed. A day's two sleeps are two readings of one quantity, so the
  // day averages them, exactly as a flare day's two peak-flow blows average.
  //
  // AVERAGING IS NOT THE SOURCE ELECTION. Which of two SOURCES a night states is
  // `pointSourceRank` below, not this set — an average of two sources would state a
  // number neither device reported.
  BREATHING_RATE_METRIC,
]);

/**
 * The per-day SOURCE election a point metric declares, or null when its sources average.
 *
 * WHY A POINT METRIC MAY NEED ONE. The AVG default averages every source's readings for
 * a day, and for height or a waist tape that is right: a manual entry and an imported
 * one are two measurements of one quantity and must AGREE, so their mean is the reading.
 * A wearable's nightly breathing rate is not that. A night covered by both a live Health
 * Connect sync and a Fitbit Takeout archive holds two rows that are two SPELLINGS of one
 * vendor number, and their mean is a third value neither device published — measured on
 * the record that raised #5409 as a 14.8 br/min chart point against a 13.6 br/min sleep
 * row for the same night. So the night ELECTS, by the same rank the sleep row and
 * `lib/history.ts` use: a real window beats a day label.
 *
 * The election runs BETWEEN sources; within the elected source the day still averages,
 * which is what keeps a nap and a night from summing (see `AVERAGED_METRICS` above).
 */
export function pointSourceRank(
  metric: string
): ((source: string | null) => number) | null {
  return metric === BREATHING_RATE_METRIC ? breathingRateSourceRank : null;
}

// Categorical metrics (#3167, from #3165): the stored number NAMES A CATEGORY
// rather than measuring a quantity, so no arithmetic over a day's readings is
// honest and the metric DECLINES to aggregate. This is a stronger statement than
// membership in AVERAGED_METRICS above, which only says "average rather than sum".
//
// Bristol stool form (#2785) is the first. The scale is categorical-ordinal, so
// both aggregations lie, and the two lie differently. SUM is the worse of them by
// a distance because it FABRICATES A REAL TYPE — two type-3s summing to 6 reads as
// "mushy", a value nobody recorded — while an average can only ever produce a
// fraction, which names no type at all and is visibly not one; an average also
// reports a day of type 1 and type 7 as 4, textbook-normal. The metric sat in
// AVERAGED_METRICS as a FLOOR against the additive default for exactly that
// reason, but a floor is a choice between two wrong answers. Declining is the
// right one, and the type is where it gets recorded: a comment inside a Set is
// not a guarantee any caller can see, and three modules branch on this function.
//
// The app's own Bristol reader never wanted either aggregation — lib/bristol-stool.ts
// COUNTS, and the panel shape carries no field an averaging renderer could reach for.
export const CATEGORICAL_METRICS = new Set([BRISTOL_STOOL_METRIC]);

// The per-day aggregation a metric uses: AVG for instantaneous point metrics,
// SUM for additive ones, NONE for categorical ones, which have no honest daily
// figure at all. (Every additive metric is collapsed to one source per day
// upstream before summing — see pickOneSourcePerDay in lib/metric-sources and
// the source-priority handling in lib/queries/metrics.ts, issue #14.)
//
// Every consumer switches exhaustively over this union with a `never` arm, so a
// fourth member cannot silently take an existing path.
export type MetricAggregation = "AVG" | "SUM" | "NONE";

export function metricAggregation(metric: string): MetricAggregation {
  if (CATEGORICAL_METRICS.has(metric)) return "NONE";
  return AVERAGED_METRICS.has(metric) ? "AVG" : "SUM";
}
