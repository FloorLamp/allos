import { describe, expect, it } from "vitest";
import { AVERAGED_METRICS, metricAggregation } from "../metric-buckets";

// Locks the averaged-vs-summed bucket membership that getMetricDailyTotals keys
// its AVG/SUM aggregation off. Instantaneous point metrics must average per day;
// everything additive must sum. Adding a metric to the wrong bucket silently
// double-counts (summing a point metric) or dilutes (averaging an additive one).
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
});
