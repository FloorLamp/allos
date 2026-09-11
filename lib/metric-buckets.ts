import { BRISTOL_STOOL_METRIC } from "./bristol-stool";
import { BREATHING_RATE_METRIC } from "./breathing-rate";

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
  // The sleeping breathing rate (#5409) is a point measure with a harder edge than the
  // rest: a night holds at most ONE reading per source, but it can hold two SOURCES —
  // a live Health Connect sync and a Fitbit Takeout archive covering the same week both
  // write the night, and they are two spellings of one number, not two breaths counted.
  // Summed, two agreeing 13.6s become a 27.2 br/min night, which is not merely wrong
  // but outside anything a sleeping adult does; averaged, the two agree. Registered here
  // rather than relied on being "one row a night", because the day it is two rows is
  // exactly the day the additive default would be at its most misleading.
  BREATHING_RATE_METRIC,
]);

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
