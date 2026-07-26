// The Trends → Body per-metric registry (#1067 Phase 2). ONE source of truth for
// the body metrics that get a sparkline TILE (the overview grid) AND a per-metric
// DETAIL page (`/trends/metric/<slug>`, the biomarker-view pattern applied to body
// metrics). Both surfaces key on this registry so a tile and its detail page can't
// disagree about a metric's label, unit, color, or link (the #285 rule-carrying-link
// + #482 one-identity-per-subject discipline).
//
// This module is PURE (metadata + windowing math, no DB/queries import) so it stays
// unit-testable. The series themselves are gathered by the callers:
//   - the Body tab builds each metric's series ONCE and feeds BOTH the classic chart
//     stack AND the tile grid from it (the tile is the series' 30-day tail — one
//     gather, no second computation, #221);
//   - the detail page re-derives its single metric's series through the SAME queries
//     (the biomarker-view precedent — a separate surface re-deriving via the shared
//     query layer), then windows it here.

import { chartSeries } from "./chart-colors";
import { shiftDateStr } from "./date";
import { bodyMetricHref, type AppRoute } from "./hrefs";
import { orderBodyCharts, type BodyChartDescriptor } from "./trends-body-order";
import type { BodyMetricKind } from "./types";

// Stable per-metric slugs — the `/trends/metric/<slug>` route param, the tile's
// in-page order key, and the detail-page title source. Append-only (a bookmarked
// detail link must never dangle).
export const BODY_METRIC_SLUGS = [
  // The vitals (#1486) — they joined the Body tab's tile grid when the Vitals tab
  // merged in, so a vital is a tile in `view=tiles` and a full chart in `view=all`,
  // exactly like every body metric. One view-mode semantic, no second grammar.
  "systolic",
  "diastolic",
  "spo2",
  "respiratory-rate",
  "hrv",
  "temperature",
  "skin-temp",
  "weight",
  "body-fat",
  "resting-hr",
  "height",
  "head-circ",
  "steps",
  "hr",
  "bmi",
  "lean-mass",
  "bone-mass",
  "bmr",
  "hydration",
  "calories",
  "mood",
] as const;
export type BodyMetricSlug = (typeof BODY_METRIC_SLUGS)[number];

// Which quick-add form the detail page offers (null → an integration-synced metric
// with no manual entry, e.g. steps/HR/BMI). Since #1486 there is exactly ONE manual
// form — the combined "Log measurements" — so this is a boolean-shaped union kept as
// a union only because a future second form would land here.
export type BodyQuickAddForm = "measurements" | null;

export interface BodyMetricMeta {
  slug: BodyMetricSlug;
  // Short label (the tile / chip).
  label: string;
  // Full heading (the detail-page title + the classic chart card heading).
  title: string;
  // Display-unit suffix. Empty for unitless (BMI, steps). Weight's suffix follows
  // the login's weight preference, resolved at runtime (`weightUnit: true`).
  unit: string;
  // When true, the unit suffix is the login's weight unit (appended at runtime).
  weightUnit?: boolean;
  color: string;
  decimals: number;
  // Base tile/chart order; broken by recency in orderBodyCharts.
  order: number;
  // Respects the Body tab's shared date-range control (body composition + growth).
  // Synced daily metrics are NOT windowed on the Body tab (they show the most recent
  // ~6 months); the detail page's own range control still windows every metric.
  windowed: boolean;
  // The Goal.body_metric this metric can carry a target/overlay for, if any.
  goalMetric: BodyMetricKind | null;
  // The detail-page quick-add form, if the metric is manually enterable.
  quickAdd: BodyQuickAddForm;
}

// The registry. Colors mirror the Body tab's existing chart colors so a metric keeps
// its identity across the tile, the classic chart, and the detail page.
export const BODY_METRIC_META: Record<BodyMetricSlug, BodyMetricMeta> = {
  systolic: {
    slug: "systolic",
    label: "Systolic",
    title: "Blood pressure (systolic)",
    unit: " mmHg",
    color: chartSeries.rose,
    decimals: 0,
    order: 0,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  diastolic: {
    slug: "diastolic",
    label: "Diastolic",
    title: "Blood pressure (diastolic)",
    unit: " mmHg",
    color: chartSeries.violet,
    decimals: 0,
    order: 1,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  spo2: {
    slug: "spo2",
    label: "SpO\u2082",
    title: "Oxygen saturation",
    unit: "%",
    color: chartSeries.sky,
    decimals: 0,
    order: 2,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  "respiratory-rate": {
    slug: "respiratory-rate",
    label: "Resp. rate",
    title: "Respiratory rate",
    unit: " /min",
    color: chartSeries.violet,
    decimals: 0,
    order: 3,
    windowed: true,
    goalMetric: null,
    // No manual entry field — respiratory rate arrives from a device push or a
    // document import, so its detail page offers no form (like steps/HR/BMI).
    quickAdd: null,
  },
  hrv: {
    slug: "hrv",
    label: "HRV",
    title: "Heart rate variability",
    unit: " ms",
    color: chartSeries.amber,
    decimals: 0,
    order: 5,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  // A SIGNED nightly deviation from the tracker's own rolling baseline, not an
  // absolute temperature — which is why it carries 1 decimal (the whole readable
  // range is roughly ±2 °C, where 0dp would flatten it to a constant 0) and why it
  // is NOT the `temperature` slug: wrist skin temperature is a distinct measurement
  // site from core body temperature, kept apart by the #482 exclusion discipline.
  // Import-only (the baseline is the device's and never exposed), so no quick-add.
  "skin-temp": {
    slug: "skin-temp",
    label: "Skin temp",
    title: "Skin temperature variation",
    unit: " °C",
    color: chartSeries.violet,
    decimals: 1,
    order: 6,
    windowed: true,
    goalMetric: null,
    quickAdd: null,
  },
  temperature: {
    slug: "temperature",
    label: "Temperature",
    title: "Body temperature",
    unit: " \u00b0F",
    color: chartSeries.rose,
    decimals: 1,
    order: 7,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  weight: {
    slug: "weight",
    label: "Weight",
    title: "Weight",
    unit: "",
    weightUnit: true,
    color: chartSeries.brand,
    decimals: 1,
    order: 8,
    windowed: true,
    goalMetric: "weight",
    quickAdd: "measurements",
  },
  "body-fat": {
    slug: "body-fat",
    label: "Body fat",
    title: "Body fat",
    unit: "%",
    color: chartSeries.violet,
    decimals: 1,
    order: 9,
    windowed: true,
    goalMetric: "body_fat",
    quickAdd: "measurements",
  },
  "resting-hr": {
    slug: "resting-hr",
    label: "Resting HR",
    title: "Resting heart rate",
    unit: " bpm",
    color: chartSeries.amber,
    decimals: 0,
    order: 4,
    windowed: true,
    goalMetric: "resting_hr",
    quickAdd: "measurements",
  },
  height: {
    slug: "height",
    label: "Height",
    title: "Height",
    unit: " cm",
    color: chartSeries.violet,
    decimals: 1,
    order: 10,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  "head-circ": {
    slug: "head-circ",
    label: "Head circ.",
    title: "Head circumference",
    unit: " cm",
    color: chartSeries.sky,
    decimals: 1,
    order: 11,
    windowed: true,
    goalMetric: null,
    quickAdd: "measurements",
  },
  steps: {
    slug: "steps",
    label: "Steps",
    title: "Steps per day",
    unit: "",
    color: chartSeries.sky,
    decimals: 0,
    order: 12,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  hr: {
    slug: "hr",
    label: "HR",
    title: "Heart rate (daily avg)",
    unit: " bpm",
    color: chartSeries.rose,
    decimals: 0,
    order: 13,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  bmi: {
    slug: "bmi",
    label: "BMI",
    title: "BMI",
    unit: "",
    color: chartSeries.sky,
    decimals: 1,
    order: 14,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  "lean-mass": {
    slug: "lean-mass",
    label: "Lean mass",
    title: "Lean body mass",
    unit: " kg",
    color: chartSeries.sky,
    decimals: 1,
    order: 15,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  "bone-mass": {
    slug: "bone-mass",
    label: "Bone mass",
    title: "Bone mass",
    unit: " kg",
    color: chartSeries.violet,
    decimals: 2,
    order: 16,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  bmr: {
    slug: "bmr",
    label: "BMR",
    title: "Basal metabolic rate",
    unit: " kcal",
    color: chartSeries.rose,
    decimals: 0,
    order: 17,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  hydration: {
    slug: "hydration",
    label: "Hydration",
    title: "Hydration",
    unit: " L",
    color: chartSeries.sky,
    decimals: 2,
    order: 18,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  calories: {
    slug: "calories",
    label: "Calories",
    title: "Calories (intake)",
    unit: " kcal",
    color: chartSeries.amber,
    decimals: 0,
    order: 19,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
  mood: {
    slug: "mood",
    label: "Mood",
    title: "Mood",
    unit: "",
    color: chartSeries.amber,
    decimals: 1,
    order: 20,
    windowed: false,
    goalMetric: null,
    quickAdd: null,
  },
};

export function isBodyMetricSlug(v: string): v is BodyMetricSlug {
  return (BODY_METRIC_SLUGS as readonly string[]).includes(v);
}

// Resolve a metric's display-unit suffix, appending the login's weight unit for a
// weight-preference metric (weight); every other metric's suffix is static.
export function resolveBodyMetricUnit(
  meta: BodyMetricMeta,
  weightUnit: string
): string {
  return meta.weightUnit ? ` ${weightUnit}` : meta.unit;
}

// A sparkline tile for the overview grid: the metric's metadata + its 30-day series
// tail (already in display units, oldest→newest) + presence for the has-data gate.
export interface BodyMetricTile {
  slug: BodyMetricSlug;
  label: string;
  href: AppRoute;
  unit: string;
  color: string;
  decimals: number;
  // The last-30-day tail of the metric's series — the tile's sparkline + latest +
  // delta all read from this (no second computation, #221).
  points: { date: string; value: number }[];
  present: boolean;
  latestDate: string | null;
  order: number;
}

// The last 30 days (today − 29 … today, inclusive) of a chronological series. The
// tile's "30d delta" is over exactly this slice.
export function last30DaySlice<T extends { date: string }>(
  points: readonly T[],
  todayStr: string
): T[] {
  const cutoff = shiftDateStr(todayStr, -29);
  return points.filter((p) => p.date >= cutoff);
}

// Build one overview tile from a metric's FULL display-unit series (the same array
// the classic chart renders) by taking its 30-day tail. The caller passes the series
// it already gathered — this only shapes it.
export function buildBodyMetricTile(
  meta: BodyMetricMeta,
  fullPoints: readonly { date: string; value: number }[],
  weightUnit: string,
  todayStr: string
): BodyMetricTile {
  const points = last30DaySlice(fullPoints, todayStr);
  return {
    slug: meta.slug,
    label: meta.label,
    href: bodyMetricHref(meta.slug),
    unit: resolveBodyMetricUnit(meta, weightUnit),
    color: meta.color,
    decimals: meta.decimals,
    points,
    // Presence is over the FULL series, not the 30-day tail — a metric with data
    // (but none in the last 30 days) still earns its tile; the sparkline just reads
    // empty. Mirrors the Body tab's has-data chip gate.
    present: fullPoints.length > 0,
    latestDate:
      fullPoints.length > 0 ? fullPoints[fullPoints.length - 1].date : null,
    order: meta.order,
  };
}

// A descriptor for any orderable overview tile — a metric tile OR a special tile
// (Sleep, which links to its own /sleep page rather than a metric page).
export interface OrderableTile extends BodyChartDescriptor {
  slug: string;
}

// Order the overview tiles by relevance (present first, most-recent-first, ties by
// base order) — the SAME predicate that orders the Body tab's charts + chips
// (orderBodyCharts), so the tile grid, the chart stack, and the jump chips agree.
export function orderBodyMetricTiles<T extends OrderableTile>(
  tiles: readonly T[]
): T[] {
  return orderBodyCharts(tiles);
}

// Period statistics for a metric detail page: latest / average / min / max / net
// change over each of the 7/30/90-day trailing windows, computed from the metric's
// FULL series (independent of the page's range control, so the windows always mean
// "last N days from today"). A window with no readings reports nulls.
export interface PeriodStat {
  label: string;
  days: number;
  count: number;
  latest: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  delta: number | null;
}

export function bodyMetricPeriodStats(
  points: readonly { date: string; value: number }[],
  todayStr: string,
  decimals = 1
): PeriodStat[] {
  const round = (n: number) => Number(n.toFixed(decimals));
  return [7, 30, 90].map((days) => {
    const cutoff = shiftDateStr(todayStr, -(days - 1));
    const win = points.filter((p) => p.date >= cutoff);
    const vals = win.map((p) => p.value);
    if (vals.length === 0) {
      return {
        label: `${days}d`,
        days,
        count: 0,
        latest: null,
        avg: null,
        min: null,
        max: null,
        delta: null,
      };
    }
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      label: `${days}d`,
      days,
      count: vals.length,
      latest: round(vals[vals.length - 1]),
      avg: round(sum / vals.length),
      min: round(Math.min(...vals)),
      max: round(Math.max(...vals)),
      delta: round(vals[vals.length - 1] - vals[0]),
    };
  });
}
