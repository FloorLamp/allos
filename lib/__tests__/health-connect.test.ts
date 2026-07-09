import { describe, expect, it } from "vitest";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";

// The exporter sends absolute timestamps (Z / offset). Day + minute attribution
// happens in an explicit IANA zone passed by the caller (the app's configured
// timezone), NOT the process TZ — so these tests are deterministic wherever they
// run. Most cases pin UTC via this wrapper; the DST/evening cases pass a zone.
const parse = (body: unknown, tz = "UTC") =>
  parseHealthConnectPayload(body, tz);

describe("parseHealthConnectPayload — guards", () => {
  it("returns the empty shape for non-object bodies", () => {
    const empty = {
      bodyMetrics: [],
      samples: [],
      hrMinutes: [],
      activities: [],
      vitals: [],
      skipped: 0,
    };
    expect(parse(null)).toEqual(empty);
    expect(parse("nope")).toEqual(empty);
    expect(parse(42)).toEqual(empty);
  });

  it("ignores unknown keys", () => {
    const out = parse({ something_else: [{ a: 1 }] });
    expect(out.skipped).toBe(0);
    expect(out.samples).toHaveLength(0);
  });
});

describe("parseHealthConnectPayload — body metrics", () => {
  it("keeps one body-metrics row per local day (last in array wins)", () => {
    const out = parse({
      weight: [
        { time: "2026-06-15T08:00:00Z", kilograms: 80 },
        { time: "2026-06-15T20:00:00Z", kilograms: 81 },
        { time: "2026-06-16T08:00:00Z", kg: 82 },
      ],
    });
    expect(out.bodyMetrics).toEqual([
      { date: "2026-06-15", weight_kg: 81 },
      { date: "2026-06-16", weight_kg: 82 },
    ]);
  });

  it("skips records missing a timestamp or weight", () => {
    const out = parse({
      weight: [
        { time: "bad-date", kilograms: 80 },
        { time: "2026-06-15T08:00:00Z" },
      ],
    });
    expect(out.bodyMetrics).toHaveLength(0);
    expect(out.skipped).toBe(2);
  });

  it("merges weight, body fat, and resting HR into one row per day (#120)", () => {
    const out = parse({
      weight: [{ time: "2026-06-15T07:00:00Z", kilograms: 80 }],
      body_fat: [{ time: "2026-06-15T08:00:00Z", percentage: 18.5 }],
      resting_heart_rate: [{ time: "2026-06-15T08:00:00Z", bpm: 58.6 }],
    });
    // All three land in body_metrics (rounded), and NOT in metric_samples.
    expect(out.bodyMetrics).toEqual([
      { date: "2026-06-15", weight_kg: 80, body_fat_pct: 18.5, resting_hr: 59 },
    ]);
    expect(
      out.samples.some(
        (s) => s.metric === "body_fat_pct" || s.metric === "resting_hr"
      )
    ).toBe(false);
  });

  it("emits a weightless row (day-averaged) for a body-fat / HR-only day", () => {
    const out = parse({
      body_fat: [{ time: "2026-06-16T08:00:00Z", percentage: 20 }],
      resting_heart_rate: [
        { time: "2026-06-16T06:00:00Z", bpm: 60 },
        { time: "2026-06-16T07:00:00Z", bpm: 64 },
      ],
    });
    expect(out.bodyMetrics).toEqual([
      { date: "2026-06-16", body_fat_pct: 20, resting_hr: 62 },
    ]);
  });
});

describe("parseHealthConnectPayload — metric samples", () => {
  it("converts interval distance from meters to km", () => {
    const out = parse({
      steps: [
        {
          start_time: "2026-06-15T08:00:00Z",
          end_time: "2026-06-15T09:00:00Z",
          count: 1200,
        },
      ],
      distance: [
        {
          start_time: "2026-06-15T08:00:00Z",
          end_time: "2026-06-15T09:00:00Z",
          meters: 5000,
        },
      ],
    });
    expect(out.samples).toContainEqual(
      expect.objectContaining({ metric: "steps", value: 1200 })
    );
    expect(out.samples).toContainEqual(
      expect.objectContaining({ metric: "distance_km", value: 5 })
    );
  });

  it("emits one sample per present nutrient without counting absent ones as skips", () => {
    const out = parse({
      nutrition: [
        {
          start_time: "2026-06-15T12:00:00Z",
          end_time: "2026-06-15T12:30:00Z",
          calories: 600,
          protein_grams: 40,
        },
      ],
    });
    const metrics = out.samples.map((s) => s.metric).sort();
    expect(metrics).toEqual(["nutrition_kcal", "protein_g"]);
    expect(out.skipped).toBe(0);
  });
});

describe("parseHealthConnectPayload — vitals & conversions", () => {
  it("splits blood pressure into systolic and diastolic analytes", () => {
    const out = parse({
      blood_pressure: [
        { time: "2026-06-15T08:00:00Z", systolic: 120, diastolic: 80 },
      ],
    });
    const names = out.vitals.map((v) => v.name);
    expect(names).toContain("Blood Pressure Systolic");
    expect(names).toContain("Blood Pressure Diastolic");
    const sys = out.vitals.find((v) => v.name === "Blood Pressure Systolic")!;
    expect(sys.value_num).toBe(120);
    expect(sys.unit).toBe("mmHg");
    expect(sys.external_id).toBe(
      "health-connect:Blood Pressure Systolic:2026-06-15T08:00:00Z"
    );
  });

  it("converts glucose mmol/L to mg/dL and temperature °C to °F", () => {
    const out = parse({
      blood_glucose: [{ time: "2026-06-15T08:00:00Z", mmol_per_liter: 5.5 }],
      body_temperature: [{ time: "2026-06-15T08:00:00Z", celsius: 37 }],
    });
    const glucose = out.vitals.find((v) => v.canonical === "Glucose")!;
    expect(glucose.value_num).toBeCloseTo(99.1, 1);
    expect(glucose.unit).toBe("mg/dL");
    expect(glucose.category).toBe("biomarker");
    const temp = out.vitals.find((v) => v.canonical === "Body Temperature")!;
    expect(temp.value_num).toBeCloseTo(98.6, 1);
  });
});

describe("parseHealthConnectPayload — heart rate bucketing", () => {
  it("aggregates raw samples into per-minute buckets", () => {
    const out = parse({
      heart_rate: [
        { time: "2026-06-15T08:00:10Z", bpm: 60 },
        { time: "2026-06-15T08:00:40Z", bpm: 80 },
        { time: "2026-06-15T08:01:05Z", bpm: 100 },
      ],
    });
    expect(out.hrMinutes).toHaveLength(2);
    const first = out.hrMinutes.find((m) => m.ts === "2026-06-15T08:00")!;
    expect(first.bpm).toBe(70); // (60 + 80) / 2
    expect(first.bpm_min).toBe(60);
    expect(first.bpm_max).toBe(80);
    expect(first.n).toBe(2);
  });
});

describe("parseHealthConnectPayload — activities", () => {
  it("classifies exercises and computes duration/distance", () => {
    const out = parse({
      exercise: [
        {
          type: "running",
          start_time: "2026-06-15T07:00:00Z",
          end_time: "2026-06-15T07:30:00Z",
          distance_meters: 5000,
        },
        {
          type: "basketball",
          start_time: "2026-06-15T18:00:00Z",
          end_time: "2026-06-15T19:00:00Z",
        },
      ],
    });
    const run = out.activities[0];
    expect(run.type).toBe("cardio");
    expect(run.title).toBe("Running");
    expect(run.duration_min).toBe(30);
    expect(run.distance_km).toBe(5);
    expect(run.start_time).toBe("07:00");
    expect(run.end_time).toBe("07:30");
    expect(run.external_id).toBe("health-connect:2026-06-15T07:00:00Z");

    const ball = out.activities[1];
    expect(ball.type).toBe("sport");
    expect(ball.title).toBe("Basketball");
    expect(ball.distance_km).toBeNull();
  });

  it("skips an exercise with no start time", () => {
    const out = parse({
      exercise: [{ type: "running", end_time: "2026-06-15T07:30:00Z" }],
    });
    expect(out.activities).toHaveLength(0);
    expect(out.skipped).toBe(1);
  });
});

describe("parseHealthConnectPayload — sleep", () => {
  it("emits total minutes attributed to the wake day, plus per-stage breakdown", () => {
    const out = parse({
      sleep: [
        {
          start_time: "2026-06-14T23:00:00Z",
          end_time: "2026-06-15T07:00:00Z",
          stages: [
            {
              stage: "deep",
              start_time: "2026-06-14T23:00:00Z",
              end_time: "2026-06-15T01:00:00Z",
            },
            {
              stage: "rem",
              start_time: "2026-06-15T01:00:00Z",
              end_time: "2026-06-15T02:00:00Z",
            },
            {
              stage: "unknown",
              start_time: "2026-06-15T02:00:00Z",
              end_time: "2026-06-15T02:30:00Z",
            },
          ],
        },
      ],
    });
    const total = out.samples.find((s) => s.metric === "sleep_min")!;
    expect(total.value).toBe(480); // 8h
    expect(total.date).toBe("2026-06-15"); // pinned to the wake day
    const deep = out.samples.find((s) => s.metric === "sleep_deep_min")!;
    expect(deep.value).toBe(120);
    expect(deep.date).toBe("2026-06-15");
    // The unknown-stage entry is not charted.
    expect(out.samples.some((s) => s.metric === "sleep_unknown_min")).toBe(
      false
    );
  });
});

describe("parseHealthConnectPayload — timezone attribution", () => {
  // A UTC evening instant is the NEXT calendar day in an eastern zone and the
  // SAME (or previous) day in a western zone. Day/minute must follow the passed
  // zone, not the process TZ.
  it("attributes an evening UTC event to the local day of the configured zone", () => {
    // 23:30Z on the 15th → 08:30 on the 16th in Tokyo (UTC+9).
    const body = {
      weight: [{ time: "2026-06-15T23:30:00Z", kilograms: 80 }],
      exercise: [
        {
          type: "running",
          start_time: "2026-06-15T23:30:00Z",
          end_time: "2026-06-16T00:00:00Z",
        },
      ],
    };
    const tokyo = parse(body, "Asia/Tokyo");
    expect(tokyo.bodyMetrics).toEqual([{ date: "2026-06-16", weight_kg: 80 }]);
    expect(tokyo.activities[0].date).toBe("2026-06-16");
    expect(tokyo.activities[0].start_time).toBe("08:30");

    // Same instant in New York (UTC-4 in June) is still the 15th at 19:30.
    const ny = parse(body, "America/New_York");
    expect(ny.bodyMetrics).toEqual([{ date: "2026-06-15", weight_kg: 80 }]);
    expect(ny.activities[0].date).toBe("2026-06-15");
    expect(ny.activities[0].start_time).toBe("19:30");
  });

  it("buckets heart-rate minutes in the configured zone", () => {
    const out = parse(
      {
        heart_rate: [
          { time: "2026-06-15T23:00:10Z", bpm: 60 },
          { time: "2026-06-15T23:00:50Z", bpm: 70 },
        ],
      },
      "Asia/Tokyo" // +9 → 08:00 on the 16th
    );
    expect(out.hrMinutes).toHaveLength(1);
    expect(out.hrMinutes[0].ts).toBe("2026-06-16T08:00");
    expect(out.hrMinutes[0].bpm).toBe(65);
  });
});
