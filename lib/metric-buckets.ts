import { BRISTOL_STOOL_METRIC } from "./bristol-stool";

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
  // Bristol stool form (#2785) — here as a FLOOR against the additive default, not
  // as a claim that the mean means anything. The scale is categorical-ordinal, so
  // neither aggregation is honest: an average reports a day of type 1 and type 7 as
  // 4, textbook-normal. But SUM is the worse of the two by a distance, because it
  // FABRICATES A REAL TYPE — two type-3s summing to 6 reads as "mushy", a value
  // nobody recorded — while an average can only ever produce a fraction, which names
  // no type at all and is visibly not one. The app's own reader never calls either:
  // lib/bristol-stool.ts COUNTS, and the panel shape carries no field an averaging
  // renderer could reach for.
  BRISTOL_STOOL_METRIC,
]);

// The per-day aggregation a metric uses: AVG for instantaneous point metrics,
// SUM for additive ones. (Every additive metric is collapsed to one source per
// day upstream before summing — see pickOneSourcePerDay in lib/metric-sources
// and the source-priority handling in lib/queries/metrics.ts, issue #14.)
export function metricAggregation(metric: string): "AVG" | "SUM" {
  return AVERAGED_METRICS.has(metric) ? "AVG" : "SUM";
}
