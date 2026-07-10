import { describe, expect, it } from "vitest";
import {
  METRIC_BOUNDS,
  inMetricBounds,
  boundedOrNull,
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
      ["weight_kg", 3], // newborn
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
