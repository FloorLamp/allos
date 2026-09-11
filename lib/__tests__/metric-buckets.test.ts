import { describe, expect, it } from "vitest";
import {
  AVERAGED_METRICS,
  CATEGORICAL_METRICS,
  metricAggregation,
  pointSourceRank,
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
        // The sleeping breathing rate (#5409) — one reading per SLEEP SESSION, and a
        // wake day that holds a nap and a night holds two of one source's own rows.
        // Summed they would chart a 27 br/min night no sleeping adult has ever had.
        // (Two SOURCES on one night do not sum and never did: the additive path elects
        // one source per day. They ELECT here too — see `pointSourceRank`.)
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

// #5409, and the correction round on PR #5880. AVERAGING AND ELECTING ARE TWO
// DIFFERENT RULES, and conflating them is how the body-census chart came to state
// 14.8 br/min for a night whose sleep row read 13.6 · Google Health Connect. Which of
// two SOURCES a day states is a rank; how a day's several readings OF one source
// combine is the bucket above. Only a metric whose sources are two spellings of one
// vendor number declares a rank — a tape measure and an imported waist reading are
// two measurements that must agree, so they still average.
describe("a point metric may elect between sources instead of averaging them", () => {
  it("declares the rank for the sleeping breathing rate and for nothing else", () => {
    const rank = pointSourceRank("respiratory_rate_bpm");
    expect(rank).not.toBeNull();
    // A real sleep window beats a day label, the same order the sleep row uses.
    expect(rank!("health-connect")).toBeLessThan(rank!("fitbit-takeout"));
    // An unknown source ranks last rather than throwing.
    expect(rank!("some-future-tracker")).toBeGreaterThan(
      rank!("fitbit-takeout")
    );
    expect(rank!(null)).toBeGreaterThan(rank!("fitbit-takeout"));

    for (const m of AVERAGED_METRICS) {
      if (m === "respiratory_rate_bpm") continue;
      expect(
        pointSourceRank(m),
        `${m} must not declare a source rank`
      ).toBeNull();
    }
    expect(pointSourceRank("steps")).toBeNull();
  });
});
