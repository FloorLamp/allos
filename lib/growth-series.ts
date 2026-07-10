// Pure assembly of a profile's growth trajectory across the WHO/CDC percentile
// bands (no DB, no React) — unit-tested in lib/__tests__/growth-series.test.ts.
// The DB gathering (height from metric_samples, weight from body_metrics) lives in
// the page; this module takes the raw dated series + the profile's birthdate/sex
// and, following the "age on the measurement date" rule, plots each historical
// measurement at the age it was taken, plus the current-age percentile for the
// passport badge. REFERENCE CURVES — NOT MEDICAL ADVICE.

import { ageInMonthsFromBirthdate } from "./date";
import { kgTo } from "./units";
import type { WeightUnit } from "./settings";
import {
  measurementPercentile,
  bmiFrom,
  bandCurves,
  ageRangeFor,
  MAX_AGE_MONTHS,
  type GrowthSex,
  type GrowthMetric,
  type BandCurve,
} from "./growth";

// A raw dated measurement (height in cm, or weight in kg).
export interface DatedValue {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface TrajectoryPoint {
  date: string;
  ageMonths: number;
  value: number;
  // Percentile against the age/sex reference, or null when out of chart range.
  percentile: number | null;
}

export interface GrowthMetricSeries {
  metric: GrowthMetric;
  points: TrajectoryPoint[]; // oldest → newest
  latest: TrajectoryPoint | null; // most recent in-range point (for the badge)
  bands: BandCurve[]; // reference percentile curves over the plotted age window
  // Age-axis window (months) the chart spans — the plotted data padded to the band range.
  minMonths: number;
  maxMonths: number;
}

export interface GrowthProfile {
  sex: GrowthSex;
  ageMonths: number; // current age (today)
  metrics: GrowthMetricSeries[];
}

// The latest value on or before `date` from an ascending-by-date series (for
// pairing a weight with the height in effect at that time when deriving BMI).
function latestOnOrBefore(sorted: DatedValue[], date: string): number | null {
  let out: number | null = null;
  for (const p of sorted) {
    if (p.date <= date) out = p.value;
    else break;
  }
  return out;
}

function byDateAsc(a: DatedValue, b: DatedValue): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

// Build one metric's trajectory: map every raw measurement to the age on ITS OWN
// date and score it against the sex/age reference. Points whose age falls outside
// the chart range keep a null percentile (still plotted as raw values).
function buildMetric(
  metric: GrowthMetric,
  sex: GrowthSex,
  birthdate: string,
  raw: DatedValue[],
  stepMonths: number
): GrowthMetricSeries {
  const points: TrajectoryPoint[] = [];
  for (const r of raw) {
    const ageMonths = ageInMonthsFromBirthdate(birthdate, r.date);
    if (ageMonths == null || ageMonths < 0 || ageMonths > MAX_AGE_MONTHS)
      continue;
    const res = measurementPercentile(sex, ageMonths, metric, r.value);
    points.push({
      date: r.date,
      ageMonths,
      value: r.value,
      percentile: res ? res.percentile : null,
    });
  }
  points.sort((a, b) => a.ageMonths - b.ageMonths);

  const range = ageRangeFor(sex, metric);
  const plottedMin = points.length
    ? points[0].ageMonths
    : (range?.minMonths ?? 0);
  const plottedMax = points.length
    ? points[points.length - 1].ageMonths
    : (range?.maxMonths ?? MAX_AGE_MONTHS);
  // Pad the window a little around the data so the trajectory isn't flush to the edge.
  const pad = 3;
  const minMonths = Math.max(range?.minMonths ?? 0, plottedMin - pad);
  const maxMonths = Math.min(
    range?.maxMonths ?? MAX_AGE_MONTHS,
    plottedMax + pad
  );

  const bands = bandCurves(sex, metric, { minMonths, maxMonths, stepMonths });
  // "Latest" for the badge = the newest in-range measurement. Age is monotonic in
  // date for a fixed birthdate, so points are already newest-last by ageMonths.
  let latest: TrajectoryPoint | null = null;
  for (const p of points) if (p.percentile != null) latest = p;
  return { metric, points, latest, bands, minMonths, maxMonths };
}

// Assemble the growth trajectories (height, weight, BMI, head circumference) for a
// profile. Returns
// null when the feature should not render at all: sex unknown, birthdate unknown,
// or the child is out of chart range today (older than ~20 y) — the caller then
// falls back to the plain adult BMI display.
export function buildGrowthProfile(input: {
  sex: GrowthSex | null;
  birthdate: string | null;
  today: string;
  heights: DatedValue[]; // date + cm
  weights: DatedValue[]; // date + kg
  // Head-circumference samples (date + cm). Optional — a pediatric-only metric;
  // when absent the head-circumference series is empty and the page hides its chart.
  headCircs?: DatedValue[];
  stepMonths?: number;
}): GrowthProfile | null {
  const { sex, birthdate, today } = input;
  if (!sex || !birthdate) return null;
  const ageMonths = ageInMonthsFromBirthdate(birthdate, today);
  if (ageMonths == null || ageMonths < 0 || ageMonths > MAX_AGE_MONTHS)
    return null;

  const step = input.stepMonths ?? 1;
  const heights = [...input.heights].sort(byDateAsc);
  const weights = [...input.weights].sort(byDateAsc);
  const headCircs = [...(input.headCircs ?? [])].sort(byDateAsc);

  // BMI trajectory: for each weigh-in, pair it with the height in effect that day.
  const bmiRaw: DatedValue[] = [];
  for (const w of weights) {
    const h = latestOnOrBefore(heights, w.date);
    const bmi = bmiFrom(w.value, h);
    if (bmi != null) bmiRaw.push({ date: w.date, value: bmi });
  }

  const metrics: GrowthMetricSeries[] = [
    buildMetric("height", sex, birthdate, heights, step),
    buildMetric("weight", sex, birthdate, weights, step),
    buildMetric("bmi", sex, birthdate, bmiRaw, step),
    // Head-circumference-for-age (WHO 0–24 mo). buildMetric returns an empty
    // series when there are no in-range samples, so the page's chart simply hides.
    buildMetric("head_circumference", sex, birthdate, headCircs, step),
  ];

  return { sex, ageMonths, metrics };
}

// Convert a weight growth series into a display weight unit for the chart.
// Percentiles are computed in kg upstream (in buildMetric) and are NOT touched
// here — only the plotted values are converted, and the reference BANDS and the
// child's own trajectory POINTS are converted TOGETHER so the plot stays
// coherent (converting only the points would float the trajectory off its
// bands). A no-op for kg, and only meaningful for the weight metric — height /
// BMI / head-circumference carry no weight unit. (issue #194)
export function displayWeightGrowth(
  series: Pick<GrowthMetricSeries, "bands" | "points">,
  unit: WeightUnit
): { bands: BandCurve[]; points: TrajectoryPoint[] } {
  if (unit === "kg") return { bands: series.bands, points: series.points };
  return {
    bands: series.bands.map((b) => ({
      ...b,
      points: b.points.map((p) => ({ ...p, value: kgTo(p.value, unit) })),
    })),
    points: series.points.map((p) => ({ ...p, value: kgTo(p.value, unit) })),
  };
}

// The three current percentiles for the passport badge, from the latest in-range
// measurement of each metric. Any may be null (no data / out of range).
export interface GrowthBadge {
  heightPercentile: number | null;
  weightPercentile: number | null;
  bmiPercentile: number | null;
}

export function growthBadge(profile: GrowthProfile | null): GrowthBadge | null {
  if (!profile) return null;
  const pick = (m: GrowthMetric) =>
    profile.metrics.find((x) => x.metric === m)?.latest?.percentile ?? null;
  const badge = {
    heightPercentile: pick("height"),
    weightPercentile: pick("weight"),
    bmiPercentile: pick("bmi"),
  };
  if (
    badge.heightPercentile == null &&
    badge.weightPercentile == null &&
    badge.bmiPercentile == null
  )
    return null;
  return badge;
}

// The passport badge from the latest scalar height/weight scored at the CURRENT
// age (no full series needed) — for the profile summary card. Null for an
// adult / out-of-range age or unknown sex, so the badge simply doesn't render.
export function currentGrowthBadge(input: {
  sex: GrowthSex | null;
  ageMonths: number | null;
  heightCm: number | null;
  weightKg: number | null;
}): GrowthBadge | null {
  const { sex, ageMonths, heightCm, weightKg } = input;
  if (!sex || ageMonths == null || ageMonths < 0 || ageMonths > MAX_AGE_MONTHS)
    return null;
  const score = (metric: GrowthMetric, value: number | null) =>
    value != null
      ? (measurementPercentile(sex, ageMonths, metric, value)?.percentile ??
        null)
      : null;
  const badge = {
    heightPercentile: score("height", heightCm),
    weightPercentile: score("weight", weightKg),
    bmiPercentile: score("bmi", bmiFrom(weightKg, heightCm)),
  };
  if (
    badge.heightPercentile == null &&
    badge.weightPercentile == null &&
    badge.bmiPercentile == null
  )
    return null;
  return badge;
}
