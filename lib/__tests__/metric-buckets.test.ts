import { describe, expect, it } from "vitest";
import {
  AVERAGED_METRICS,
  CATEGORICAL_METRICS,
  metricAggregation,
} from "../metric-buckets";

// Locks the bucket membership that getMetricDailyTotals keys its AVG/SUM/NONE
// aggregation off. Instantaneous point metrics must average per day; everything
// additive must sum. Adding a metric to the wrong bucket silently double-counts
// (summing a point metric) or dilutes (averaging an additive one). A CATEGORICAL
// metric (#3167) is in neither: its value names a category, so it aggregates by
// neither route and answers NONE.
describe("metric bucket membership", () => {
  it("averages instantaneous point metrics", () => {
    const averaged = [
      "hrv_ms",
      "lean_mass_kg",
      "muscle_mass_kg",
      "body_water_kg",
      "bone_mass_kg",
      "bmr_kcal",
      "height_cm",
      "head_circumference_cm",
      "skin_temp_delta_c",
      "respiratory_rate_bpm",
    ];
    for (const m of averaged) {
      expect(AVERAGED_METRICS.has(m)).toBe(true);
      expect(metricAggregation(m)).toBe("AVG");
    }
  });

  it("is exactly the set of averaged metrics (no accidental additions)", () => {
    expect([...AVERAGED_METRICS].sort()).toEqual(
      [
        "bmr_kcal",
        "body_water_kg",
        "bone_mass_kg",
        "head_circumference_cm",
        "height_cm",
        "hrv_ms",
        "lean_mass_kg",
        "muscle_mass_kg",
        // Signed delta from the device's own baseline — summing two +0.3 °C nights
        // into +0.6 °C would report a deviation neither night had.
        "skin_temp_delta_c",
        // Peak expiratory flow (#1850) — a flare day's morning and evening blows are
        // repeat measurements of one quantity; summing them would chart a value
        // nobody blew, on the surface whose whole job is "is this dropping?".
        "peak_flow_lmin",
        // Waist circumference (#2322) — a point measure like height: a tape reading
        // and a same-date imported one must AGREE, never sum.
        "waist_circumference_cm",
        // The sleeping breathing rate (#5409) — one reading per night per SOURCE, and a
        // night covered by both a Health Connect sync and a Fitbit Takeout archive holds
        // two of them. They are two spellings of one night, so they must average; summed
        // they would chart a 27 br/min night no sleeping adult has ever had.
        "respiratory_rate_bpm",
      ].sort()
    );
  });

  it("sums additive metrics", () => {
    const summed = [
      "steps",
      "distance_km",
      "active_energy_kcal",
      "hydration_ml",
      "sleep_deep_min",
      "sleep_rem_min",
      "flights_climbed",
    ];
    for (const m of summed) {
      expect(AVERAGED_METRICS.has(m)).toBe(false);
      expect(metricAggregation(m)).toBe("SUM");
    }
  });

  it("defaults an unknown metric to SUM", () => {
    expect(metricAggregation("some_new_metric")).toBe("SUM");
  });

  // #3167. Bristol left AVERAGED_METRICS, where it had sat as a floor against the
  // additive default: averaging a categorical-ordinal scale is the less bad of two
  // wrong answers, not a right one. It must not be in either arithmetic bucket, and
  // it must not fall through to the SUM default either.
  it("a categorical metric aggregates by neither route", () => {
    expect([...CATEGORICAL_METRICS]).toEqual(["bristol_stool_type"]);
    for (const m of CATEGORICAL_METRICS) {
      expect(AVERAGED_METRICS.has(m)).toBe(false);
      expect(metricAggregation(m)).toBe("NONE");
    }
  });
});
