import { describe, expect, it } from "vitest";
import {
  METRIC_BOUNDS,
  METRIC_ROUND_DP,
  inMetricBounds,
  boundedOrNull,
  roundForMetric,
  inTimeWindow,
  MIN_INGEST_TIME_MS,
  FUTURE_SLACK_MS,
  MAX_INGEST_RECORDS,
  countPayloadRecords,
} from "@/lib/ingest-bounds";

// Issue #132: physiological plausibility bounds for integration ingest. These are
// pure; the parsers wire them in so an out-of-bounds value folds into the existing
// skip-and-count path (reflected in the Review inbox's "· N skipped").

describe("inMetricBounds", () => {
  it("accepts the endpoints of a registered range (inclusive)", () => {
    const b = METRIC_BOUNDS.weight_kg;
    expect(inMetricBounds("weight_kg", b.min)).toBe(true);
    expect(inMetricBounds("weight_kg", b.max)).toBe(true);
  });

  it("rejects values just outside a registered range", () => {
    const b = METRIC_BOUNDS.weight_kg;
    expect(inMetricBounds("weight_kg", b.min - 0.01)).toBe(false);
    expect(inMetricBounds("weight_kg", b.max + 0.01)).toBe(false);
  });

  it("passes through an UNKNOWN metric (bounds are opt-in)", () => {
    // A metric with no curated envelope must not be silently dropped.
    expect(inMetricBounds("no_such_metric", 1e9)).toBe(true);
    expect(inMetricBounds("no_such_metric", -1e9)).toBe(true);
  });

  it("rejects non-finite values even for an unknown metric", () => {
    expect(inMetricBounds("weight_kg", NaN)).toBe(false);
    expect(inMetricBounds("weight_kg", Infinity)).toBe(false);
    expect(inMetricBounds("no_such_metric", NaN)).toBe(false);
    expect(inMetricBounds("no_such_metric", -Infinity)).toBe(false);
  });

  // The issue's concrete absurd examples must all be rejected...
  it("rejects the absurd values named in the issue", () => {
    expect(inMetricBounds("weight_kg", 5000)).toBe(false); // 5,000 kg
    expect(inMetricBounds("weight_kg", -1)).toBe(false); // negative weight
    expect(inMetricBounds("resting_hr", 0)).toBe(false); // 0 bpm resting
    expect(inMetricBounds("resting_hr", 500)).toBe(false); // 500 bpm
    expect(inMetricBounds("heart_rate_bpm", 500)).toBe(false);
    expect(inMetricBounds("steps", -10)).toBe(false); // negative steps
    expect(inMetricBounds("Oxygen Saturation", 900)).toBe(false); // SpO2 > 100
    expect(inMetricBounds("Oxygen Saturation", 101)).toBe(false);
  });

  // ...while plausible human values — including athletic/clinical outliers — pass.
  it("accepts plausible outliers across every metric family", () => {
    const plausible: [string, number][] = [
      ["weight_kg", 3], // term newborn
      ["weight_kg", 1.6], // premature / low-birth-weight infant (issue #191)
      ["weight_kg", 250], // extreme but real adult
      ["body_fat_pct", 4], // very lean athlete
      ["body_fat_pct", 60], // extreme obesity
      ["resting_hr", 28], // elite endurance athlete
      ["heart_rate_bpm", 205], // near-max effort
      ["steps", 120_000], // 24h ultra
      ["distance_km", 250], // ultra event
      ["active_kcal", 8000], // Tour stage
      ["hydration_l", 6],
      ["Glucose", 25], // severe hypoglycemia
      ["Glucose", 900], // severe DKA
      ["Oxygen Saturation", 100],
      ["Oxygen Saturation", 70], // profound hypoxia
      ["Body Temperature", 95], // hypothermia (°F)
      ["Body Temperature", 107], // extreme fever (°F)
      ["Respiratory Rate", 8],
      ["Respiratory Rate", 45],
      ["Blood Pressure Systolic", 210], // hypertensive crisis
      ["Blood Pressure Diastolic", 130],
      ["VO2 Max", 85], // elite
      ["sleep_min", 600],
      ["hrv_ms", 180],
      ["duration_min", 1440], // long ultra session
      ["speed_kmh", 70], // descent
      ["power_w", 1800], // sprint
    ];
    for (const [metric, value] of plausible) {
      expect(inMetricBounds(metric, value)).toBe(true);
    }
  });

  // Issue #191: the weight floor must clear the lightest surviving newborn
  // (≈0.25 kg) its own comment names, since the app tracks kids + growth charts.
  // Below the floor is still "physically impossible" and rejected.
  it("admits a preemie weight but still rejects a sub-floor value", () => {
    expect(inMetricBounds("weight_kg", 1.6)).toBe(true); // preemie
    expect(inMetricBounds("weight_kg", 0.25)).toBe(true); // lightest surviving newborn
    expect(inMetricBounds("weight_kg", 0.1)).toBe(false); // below the 0.2 kg floor
    expect(inMetricBounds("weight_kg", 0)).toBe(false);
  });

  it("caps sleep stages and totals at 24h", () => {
    for (const m of [
      "sleep_min",
      "sleep_deep_min",
      "sleep_rem_min",
      "sleep_light_min",
      "sleep_awake_min",
    ]) {
      expect(inMetricBounds(m, 1440)).toBe(true);
      expect(inMetricBounds(m, 1441)).toBe(false);
      expect(inMetricBounds(m, -1)).toBe(false);
    }
  });
});

describe("boundedOrNull", () => {
  it("returns the value when in bounds", () => {
    expect(boundedOrNull("weight_kg", 80)).toBe(80);
    expect(boundedOrNull("steps", 0)).toBe(0);
  });

  it("returns null for an out-of-bounds value", () => {
    expect(boundedOrNull("weight_kg", 5000)).toBeNull();
    expect(boundedOrNull("resting_hr", 500)).toBeNull();
  });

  it("passes null straight through (missing value stays missing)", () => {
    expect(boundedOrNull("weight_kg", null)).toBeNull();
  });

  it("passes an unknown metric's value through unchanged", () => {
    expect(boundedOrNull("no_such_metric", 12345)).toBe(12345);
  });

  // Issue #1109: boundedOrNull is the shared point every provider funnels canonical
  // values through, so it also rounds to the metric's storage precision — a raw
  // provider float never reaches storage.
  it("rounds an in-bounds value to the metric's storage precision", () => {
    // The concrete full-precision floats from the real HC payload in the issue.
    expect(boundedOrNull("distance_km", 32.397218025887694)).toBe(32.4);
    expect(boundedOrNull("distance_km", 27.83881802588772)).toBe(27.84);
    expect(boundedOrNull("weight_kg", 70.43821)).toBe(70.44);
    expect(boundedOrNull("active_kcal", 470.60464280472473)).toBe(470.6);
    expect(boundedOrNull("hydration_l", 19.519318)).toBe(19.5);
  });

  it("still returns null when an out-of-bounds value would round into range", () => {
    // Bounds run on the RAW value, so a 5,000 kg reading is dropped, not rounded.
    expect(boundedOrNull("weight_kg", 5000.004)).toBeNull();
  });
});

describe("roundForMetric (issue #1109)", () => {
  it("rounds masses and distance to 2dp", () => {
    expect(roundForMetric("weight_kg", 70.43821)).toBe(70.44);
    expect(roundForMetric("distance_km", 32.397218025887694)).toBe(32.4);
    expect(roundForMetric("lean_mass_kg", 55.678)).toBe(55.68);
    expect(roundForMetric("bone_mass_kg", 2.9449)).toBe(2.94);
    expect(roundForMetric("body_water_kg", 41.2351)).toBe(41.24);
    expect(roundForMetric("muscle_mass_kg", 30.005)).toBe(30.01);
  });

  it("rounds energy, grams, and liters to 1dp", () => {
    expect(roundForMetric("active_kcal", 470.60464280472473)).toBe(470.6);
    expect(roundForMetric("total_kcal", 2145.987)).toBe(2146);
    expect(roundForMetric("nutrition_kcal", 450.05)).toBe(450.1);
    expect(roundForMetric("protein_g", 30.449)).toBe(30.4);
    expect(roundForMetric("hydration_l", 19.519318)).toBe(19.5);
    expect(roundForMetric("sodium_g", 2.349)).toBe(2.3);
  });

  it("leaves an unregistered metric and a non-finite value unchanged", () => {
    expect(roundForMetric("steps", 12345)).toBe(12345);
    expect(roundForMetric("resting_hr", 58)).toBe(58);
    expect(roundForMetric("no_such_metric", 1.23456789)).toBe(1.23456789);
    expect(roundForMetric("weight_kg", NaN)).toBeNaN();
  });

  it("is idempotent — re-rounding an already-rounded value is a fixed point", () => {
    // Deterministic idempotency is what keeps the SELECT-before-compare upserts
    // seeing equality on a re-push (unchanged, not a spurious write).
    for (const [metric] of Object.entries(METRIC_ROUND_DP)) {
      const once = roundForMetric(metric, 12.3456789);
      expect(roundForMetric(metric, once)).toBe(once);
    }
  });

  it("every rounded metric carries a plausibility bound (both opt-in maps agree)", () => {
    for (const metric of Object.keys(METRIC_ROUND_DP)) {
      expect(METRIC_BOUNDS[metric]).toBeDefined();
    }
  });
});

describe("inTimeWindow", () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0); // fixed "now" for determinism

  it("accepts an ordinary recent instant", () => {
    expect(inTimeWindow(Date.UTC(2026, 5, 15, 8, 0, 0), now)).toBe(true);
  });

  it("accepts an instant within the future slack (clock skew)", () => {
    expect(inTimeWindow(now + FUTURE_SLACK_MS - 1000, now)).toBe(true);
    expect(inTimeWindow(now + FUTURE_SLACK_MS, now)).toBe(true);
  });

  it("rejects an instant beyond the future slack", () => {
    expect(inTimeWindow(now + FUTURE_SLACK_MS + 1000, now)).toBe(false);
    // Year-3000 export bug.
    expect(inTimeWindow(Date.UTC(3000, 0, 1), now)).toBe(false);
  });

  it("rejects a pre-1900 instant", () => {
    expect(inTimeWindow(MIN_INGEST_TIME_MS - 1, now)).toBe(false);
    expect(inTimeWindow(Date.UTC(1850, 0, 1), now)).toBe(false);
  });

  it("accepts exactly the 1900 lower edge", () => {
    expect(inTimeWindow(MIN_INGEST_TIME_MS, now)).toBe(true);
  });

  it("rejects a non-finite instant", () => {
    expect(inTimeWindow(NaN, now)).toBe(false);
    expect(inTimeWindow(Infinity, now)).toBe(false);
  });
});

describe("countPayloadRecords", () => {
  it("returns 0 for a non-object body", () => {
    expect(countPayloadRecords(null)).toBe(0);
    expect(countPayloadRecords("nope")).toBe(0);
    expect(countPayloadRecords(42)).toBe(0);
  });

  it("sums the lengths of top-level arrays, ignoring non-array keys", () => {
    const body = {
      timestamp: "2026-07-10T00:00:00Z",
      app_version: "1.2.3",
      weight: [{ time: "t", kg: 80 }],
      steps: [{}, {}, {}],
      not_an_array: { a: 1 },
    };
    expect(countPayloadRecords(body)).toBe(4);
  });

  it("also counts nested per-session sleep stages", () => {
    const body = {
      sleep: [
        { start_time: "a", end_time: "b", stages: [{}, {}] },
        { start_time: "c", end_time: "d", stages: [{}] },
      ],
      steps: [{}],
    };
    // 2 sleep sessions + 3 stages + 1 step = 6
    expect(countPayloadRecords(body)).toBe(6);
  });

  it("is under the generous cap for a realistic batch and over it for abuse", () => {
    const realistic = {
      heart_rate: new Array(3000).fill({ time: "t", bpm: 60 }),
    };
    expect(countPayloadRecords(realistic)).toBeLessThan(MAX_INGEST_RECORDS);
    const abusive = { heart_rate: new Array(MAX_INGEST_RECORDS + 1).fill({}) };
    expect(countPayloadRecords(abusive)).toBeGreaterThan(MAX_INGEST_RECORDS);
  });
});
