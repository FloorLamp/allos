// Instantaneous (point) metrics: a day can hold several readings, so they must be
// averaged per day, not summed. Everything else (steps, distance, calories,
// hydration, nutrition, sleep totals) is genuinely additive. body_fat_pct /
// resting_hr are absent: they now live in body_metrics, not metric_samples.
export const AVERAGED_METRICS = new Set([
  "hrv_ms",
  "lean_mass_kg",
  "bone_mass_kg",
  "bmr_kcal",
  "height_cm",
  // Head circumference is a point measure like height: a day holds at most one
  // reading, so a same-date manual entry + imported reading must AVERAGE (agree),
  // never SUM into a doubled value on the growth chart.
  "head_circumference_cm",
]);

// The per-day aggregation a metric uses: AVG for instantaneous point metrics,
// SUM for additive ones. (Every additive metric is collapsed to one source per
// day upstream before summing — see pickOneProviderPerDay in lib/metric-providers
// and the source-priority handling in lib/queries/metrics.ts, issue #14.)
export function metricAggregation(metric: string): "AVG" | "SUM" {
  return AVERAGED_METRICS.has(metric) ? "AVG" : "SUM";
}
