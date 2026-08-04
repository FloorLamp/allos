// The full display-unit series used when a saved Body metric is reconstructed on
// Trends Overview. It follows the same registry/store mapping as the detail page,
// including BMI, daylight and vitals.

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
import { bmiSeriesDatePaired } from "./growth-series";
import { moodSeriesPoints } from "./mood";
import { dispWeight, round } from "./units";
import { lastNDates } from "./date";
import { ALL_ROWS } from "./trends";
import { BODY_METRIC_META, type BodyMetricSlug } from "./trends-body-metrics";
import { foldObservationPoints } from "./reading-model";
import type { WeightUnit } from "./settings";

// Daylight is derived from activity dates rather than read from a row store. A
// year matches the widest horizon the Body surfaces currently chart.
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

// Fold in the same-identity OBSERVATIONS a stream metric's own store never sees
// (#1996), rounded exactly as its stream points are so a cross-store duplicate
// still collapses. Empty — and free — for every metric with no fold identity,
// which is most of them; the observation read is the request-cached
// getBiomarkerSeries, so the detail page asking again for its readings table costs
// nothing.
//
// It lives HERE, in the shared series, rather than on the detail page: the tile
// grid, the Body tab chart and the detail page all read this function, and a fold
// applied to only one of them would be the same reading answering one question two
// ways (#221).
function withObservations(
  slug: BodyMetricSlug,
  profileId: number,
  points: { date: string; value: number }[]
): { date: string; value: number }[] {
  const observations = getMetricObservations(profileId, slug);
  if (observations.length === 0) return points;
  const decimals = BODY_METRIC_META[slug].decimals;
  return foldObservationPoints(
    points,
    observations.map((r) => ({ ...r, value: round(r.value, decimals) }))
  ).map((p) => ({ date: p.date, value: p.value }));
}

export function fullBodyMetricSeries(
  slug: BodyMetricSlug,
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
    case "skin-temp":
      return getMetricDailyTotals(
        profileId,
        SKIN_TEMP_DELTA_METRIC,
        ALL_ROWS
      ).map((row) => ({
        date: row.date,
        value: round(row.value, BODY_METRIC_META["skin-temp"].decimals),
      }));
    case "weight":
      return getBodyMetricDailySeries(profileId, "weight", ALL_ROWS).map(
        (point) => ({
          date: point.date,
          value: dispWeight(point.value, weightUnit),
        })
      );
    case "body-fat":
      return withObservations(
        slug,
        profileId,
        getBodyMetricDailySeries(profileId, "body_fat", ALL_ROWS).map(
          (point) => ({ date: point.date, value: round(point.value, 1) })
        )
      );
    case "resting-hr":
      return withObservations(
        slug,
        profileId,
        getBodyMetricDailySeries(profileId, "resting_hr", ALL_ROWS).map(
          (point) => ({ date: point.date, value: Math.round(point.value) })
        )
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
      return bmiSeriesDatePaired(
        getBodyMetricDailySeries(profileId, "weight", ALL_ROWS).map((row) => ({
          date: row.date,
          value: row.value,
        })),
        getMetricDailyTotals(profileId, "height_cm", ALL_ROWS).map((row) => ({
          date: row.date,
          value: row.value,
        }))
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
