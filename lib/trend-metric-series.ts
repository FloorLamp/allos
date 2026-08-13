// The full display-unit series used when a saved trend metric is reconstructed on
// Trends Overview. It follows the same registry/store mapping as the detail page,
// including mood, steps, BMI, daylight, vitals, and `body_metrics` rows.

import {
  getBiomarkerSeries,
  getMetricObservations,
  getBodyMetricDailySeries,
  getDaylightOutdoorMinutesSeries,
  getMetricDailyTotals,
  getHrDailySummary,
  getMoodLogs,
} from "./queries";
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "./vitals-input";
import { PEAK_FLOW_METRIC } from "./peak-flow";
import { WAIST_CIRC_METRIC } from "./waist-circ-extract";
import { bmiSeriesDatePaired } from "./growth-series";
import { getProfileBirthdate } from "./settings/profile-attrs";
import { moodSeriesPoints } from "./mood";
import { dispWeight, round } from "./units";
import { lastNDates } from "./date";
import { ALL_ROWS } from "./trends";
import { TREND_METRIC_META, type TrendMetricSlug } from "./trend-metrics";
import {
  foldObservationPoints,
  foldObservations,
  type Reading,
} from "./reading-model";
import type { WeightUnit } from "./settings";

// Daylight is derived from activity dates rather than read from a row store. A
// year matches the widest horizon these Trends surfaces currently chart.
const SUN_SERIES_DAYS = 366;

function biomarkerPoints(
  canonical: string,
  profileId: number,
  decimals: number
): { date: string; value: number }[] {
  return getBiomarkerSeries(profileId, canonical)
    .filter((row) => row.value_num != null)
    .map((row) => ({
      date: row.date,
      value: round(row.value_num as number, decimals),
    }));
}

// A metric's series and the same-identity OBSERVATIONS folded into it — the ONE
// answer to "how many readings does this day have" (#2029).
//
// Both halves come out of ONE decision (`foldObservations`) so the chart and the
// readings table beneath it cannot disagree: before this, the fold lived only in
// the series and the detail page's table concatenated every observation back in,
// so a clinic value equal to the wearable's plotted once and listed twice.
export interface TrendMetricSeriesFold {
  /** The charted points — the metric's stream plus the surviving observations. */
  points: { date: string; value: number }[];
  /**
   * The observations that SURVIVED the fold, values rounded to the metric's
   * display decimals exactly as its stream points are (so a cross-store duplicate
   * collapses on the number a person actually sees). Every one of these is plotted;
   * an observation the stream already carries is in neither half.
   */
  observations: Reading[];
}

// The metric's own stream series, BEFORE the observation fold — the store-shaped
// half, in display units.
function streamMetricSeries(
  slug: TrendMetricSlug,
  profileId: number,
  weightUnit: WeightUnit,
  todayStr: string
): { date: string; value: number }[] {
  switch (slug) {
    case "systolic":
      return biomarkerPoints("Blood Pressure Systolic", profileId, 0);
    case "diastolic":
      return biomarkerPoints("Blood Pressure Diastolic", profileId, 0);
    case "spo2":
      return biomarkerPoints("Oxygen Saturation", profileId, 0);
    case "respiratory-rate":
      return biomarkerPoints("Respiratory Rate", profileId, 0);
    case "temperature":
      return biomarkerPoints("Body Temperature", profileId, 1);
    case "hrv":
      return getMetricDailyTotals(profileId, HRV_METRIC, ALL_ROWS).map(
        (row) => ({ date: row.date, value: Math.round(row.value) })
      );
    case "peak-flow":
      // Averaged per day by the shared bucket rule (#1850) — a day's blows are
      // repeat measurements of one quantity, never an additive total.
      return getMetricDailyTotals(profileId, PEAK_FLOW_METRIC, ALL_ROWS).map(
        (row) => ({ date: row.date, value: Math.round(row.value) })
      );
    case "skin-temp":
      return getMetricDailyTotals(
        profileId,
        SKIN_TEMP_DELTA_METRIC,
        ALL_ROWS
      ).map((row) => ({
        date: row.date,
        value: round(row.value, TREND_METRIC_META["skin-temp"].decimals),
      }));
    case "weight":
      return getBodyMetricDailySeries(profileId, "weight", ALL_ROWS).map(
        (point) => ({
          date: point.date,
          value: dispWeight(point.value, weightUnit),
        })
      );
    case "body-fat":
      return getBodyMetricDailySeries(profileId, "body_fat", ALL_ROWS).map(
        (point) => ({ date: point.date, value: round(point.value, 1) })
      );
    case "resting-hr":
      return getBodyMetricDailySeries(profileId, "resting_hr", ALL_ROWS).map(
        (point) => ({ date: point.date, value: Math.round(point.value) })
      );
    case "height":
      return getMetricDailyTotals(profileId, "height_cm", ALL_ROWS).map(
        (row) => ({ date: row.date, value: round(row.value, 1) })
      );
    case "head-circ":
      return getMetricDailyTotals(
        profileId,
        "head_circumference_cm",
        ALL_ROWS
      ).map((row) => ({ date: row.date, value: round(row.value, 1) }));
    case "waist-circ":
      // Averaged per day by the shared bucket rule (#2322) — a tape reading and a
      // same-date imported one are repeat measurements of one quantity.
      return getMetricDailyTotals(profileId, WAIST_CIRC_METRIC, ALL_ROWS).map(
        (row) => ({ date: row.date, value: round(row.value, 1) })
      );
    case "sun":
      return getDaylightOutdoorMinutesSeries(
        profileId,
        lastNDates(todayStr, SUN_SERIES_DAYS)
      );
    case "steps":
      return getMetricDailyTotals(profileId, "steps", ALL_ROWS).map((row) => ({
        date: row.date,
        value: Math.round(row.value),
      }));
    case "active-calories":
      return getMetricDailyTotals(profileId, "active_kcal", ALL_ROWS).map(
        (row) => ({ date: row.date, value: Math.round(row.value) })
      );
    case "hr":
      return getHrDailySummary(profileId, 3650).map((row) => ({
        date: row.date,
        value: Math.round(row.avg),
      }));
    case "bmi":
      // The ONE BMI derivation (#2646 decision 3). The birthdate is what bounds how
      // stale the paired height may be — for a growing profile a months-old height
      // reads growth as fatness — so this reader resolves it rather than defaulting
      // to the unbounded adult rule.
      return bmiSeriesDatePaired(
        getBodyMetricDailySeries(profileId, "weight", ALL_ROWS).map((row) => ({
          date: row.date,
          value: row.value,
        })),
        getMetricDailyTotals(profileId, "height_cm", ALL_ROWS).map((row) => ({
          date: row.date,
          value: row.value,
        })),
        getProfileBirthdate(profileId)
      ).map((point) => ({ date: point.date, value: round(point.value, 1) }));
    case "lean-mass":
      return getMetricDailyTotals(profileId, "lean_mass_kg", ALL_ROWS).map(
        (row) => ({ date: row.date, value: round(row.value, 1) })
      );
    case "bone-mass":
      return getMetricDailyTotals(profileId, "bone_mass_kg", ALL_ROWS).map(
        (row) => ({ date: row.date, value: round(row.value, 2) })
      );
    case "bmr":
      return getMetricDailyTotals(profileId, "bmr_kcal", ALL_ROWS).map(
        (row) => ({ date: row.date, value: Math.round(row.value) })
      );
    case "hydration":
      return getMetricDailyTotals(profileId, "hydration_l", ALL_ROWS).map(
        (row) => ({ date: row.date, value: round(row.value, 2) })
      );
    case "calories":
      return getMetricDailyTotals(profileId, "nutrition_kcal", ALL_ROWS).map(
        (row) => ({ date: row.date, value: Math.round(row.value) })
      );
    // The daily check-in's three ratings (#1408) — ONE read of the mood rows, mapped
    // by the ONE pure series function every check-in surface shares (#221). `calm`
    // comes out on its #1313 display axis, exactly as the card and the census draw it.
    case "mood":
      return moodSeriesPoints(getMoodLogs(profileId), "valence");
    case "energy":
      return moodSeriesPoints(getMoodLogs(profileId), "energy");
    case "calm":
      return moodSeriesPoints(getMoodLogs(profileId), "calm");
  }
}

// The metric's series together with the observations folded into it (#2029).
//
// It lives HERE, in the shared series, rather than on the detail page: the tile
// grid, the body census chart and the detail page all read this, and a fold applied to
// only one of them would be the same reading answering one question two ways
// (#221). Free for every metric with no fold identity, which is most of them —
// `getMetricObservations` returns nothing for those, and for the rest the
// observation read is the request-cached `getBiomarkerSeries`, so the detail page
// asking for the surviving rows costs no second query.
export function trendMetricSeriesFold(
  slug: TrendMetricSlug,
  profileId: number,
  weightUnit: WeightUnit,
  todayStr: string
): TrendMetricSeriesFold {
  const stream = streamMetricSeries(slug, profileId, weightUnit, todayStr);
  const candidates = getMetricObservations(profileId, slug);
  if (candidates.length === 0) return { points: stream, observations: [] };
  const decimals = TREND_METRIC_META[slug].decimals;
  const observations = foldObservations(
    stream,
    candidates.map((r) => ({ ...r, value: round(r.value, decimals) }))
  );
  return {
    points: foldObservationPoints(stream, observations).map((p) => ({
      date: p.date,
      value: p.value,
    })),
    observations,
  };
}

// The charted half on its own — every series caller that has no readings table to
// keep in step with.
export function fullTrendMetricSeries(
  slug: TrendMetricSlug,
  profileId: number,
  weightUnit: WeightUnit,
  todayStr: string
): { date: string; value: number }[] {
  return trendMetricSeriesFold(slug, profileId, weightUnit, todayStr).points;
}
