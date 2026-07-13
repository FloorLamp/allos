import { describe, expect, it } from "vitest";
import {
  parseHealthConnectPayload,
  countUnknownRecords,
  KNOWN_HEALTH_CONNECT_KEYS,
} from "@/lib/integrations/health-connect";

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

  it("counts unknown record types as skipped instead of silently dropping them (#419)", () => {
    // Health Connect types with no model home (FloorsClimbed, ElevationGained, Power,
    // Speed, cadence, the menstrual family, …) map to nothing — but their records must
    // show up in the received/skipped tally, not vanish.
    const out = parse({
      floors_climbed: [{ floors: 12 }, { floors: 8 }],
      elevation_gained: [{ meters: 40 }],
      menstruation_period: [{ time: "2026-06-15T00:00:00Z" }],
    });
    expect(out.skipped).toBe(4);
    expect(out.samples).toHaveLength(0);
    expect(out.activities).toHaveLength(0);
  });

  it("non-array metadata keys are never counted", () => {
    const out = parse({
      timestamp: "2026-06-15T08:00:00Z",
      app_version: "1.2.3",
      unknown_scalar: 42,
      unknown_object: { nested: [1, 2, 3] },
    });
    expect(out.skipped).toBe(0);
  });

  it("a known record type is consumed, not counted as an unknown drop", () => {
    const out = parse({
      weight: [{ time: "2026-06-15T08:00:00Z", kilograms: 80 }],
      floors_climbed: [{ floors: 5 }],
    });
    expect(out.bodyMetrics).toHaveLength(1);
    // Only the one unknown floors_climbed record counts as skipped.
    expect(out.skipped).toBe(1);
  });
});

describe("countUnknownRecords", () => {
  it("sums lengths of only the top-level array keys with no home", () => {
    expect(countUnknownRecords({ floors_climbed: [1, 2], power: [3] })).toBe(3);
    expect(countUnknownRecords(null)).toBe(0);
    expect(countUnknownRecords({ steps: [1, 2, 3] })).toBe(0); // known → 0
    expect(countUnknownRecords({ note: "hi", count: 5 })).toBe(0); // non-arrays
  });

  it("every key the parser consumes is registered as known", () => {
    // Guards against the parser gaining a record type while the known-set (and thus
    // the skipped tally) forgets it — a payload of only known types must score 0.
    for (const key of KNOWN_HEALTH_CONNECT_KEYS) {
      expect(countUnknownRecords({ [key]: [{}, {}] })).toBe(0);
    }
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
    // The oldest day of a multi-day window is flagged partial (#606); it only guards
    // the averaged fields on upsert, so weight is unaffected (still last-of-day wins).
    expect(out.bodyMetrics).toEqual([
      { date: "2026-06-15", partial_day: true, weight_kg: 81 },
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

  it("merges weight, body fat, and resting HR into one row per day", () => {
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

  it("flags ONLY the oldest day of a multi-day window as partial (#606)", () => {
    // A rolling window spanning three days: the earliest day is only partially
    // covered, so its averaged fields must not overwrite a fuller stored value.
    const out = parse({
      resting_heart_rate: [
        { time: "2026-06-14T21:00:00Z", bpm: 62 }, // oldest day — partial tail
        { time: "2026-06-15T07:00:00Z", bpm: 58 },
        { time: "2026-06-15T13:00:00Z", bpm: 60 },
        { time: "2026-06-16T08:00:00Z", bpm: 59 },
      ],
    });
    const byDate = Object.fromEntries(out.bodyMetrics.map((b) => [b.date, b]));
    expect(byDate["2026-06-14"].partial_day).toBe(true);
    expect(byDate["2026-06-15"].partial_day).toBeUndefined();
    expect(byDate["2026-06-16"].partial_day).toBeUndefined();
  });

  it("does NOT flag a single-day push as partial (avoids freezing 'today')", () => {
    const out = parse({
      resting_heart_rate: [
        { time: "2026-06-16T06:00:00Z", bpm: 60 },
        { time: "2026-06-16T21:00:00Z", bpm: 64 },
      ],
    });
    expect(out.bodyMetrics).toEqual([{ date: "2026-06-16", resting_hr: 62 }]);
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

describe("parseHealthConnectPayload — plausibility bounds (#132)", () => {
  it("drops an absurd weight but keeps a plausible one, counting the reject", () => {
    const out = parse({
      weight: [
        { time: "2026-06-15T08:00:00Z", kilograms: 5000 }, // impossible
        { time: "2026-06-16T08:00:00Z", kilograms: 80 }, // fine
      ],
    });
    expect(out.bodyMetrics).toEqual([{ date: "2026-06-16", weight_kg: 80 }]);
    expect(out.skipped).toBe(1);
  });

  it("rejects a 0 / 500 bpm resting HR and negative steps", () => {
    const out = parse({
      resting_heart_rate: [
        { time: "2026-06-15T08:00:00Z", bpm: 0 },
        { time: "2026-06-15T09:00:00Z", bpm: 500 },
      ],
      steps: [
        {
          start_time: "2026-06-15T00:00:00Z",
          end_time: "2026-06-15T23:59:00Z",
          count: -100,
        },
      ],
    });
    expect(out.bodyMetrics).toHaveLength(0);
    expect(out.samples).toHaveLength(0);
    expect(out.skipped).toBe(3);
  });

  it("rejects SpO2 > 100 but keeps a valid reading", () => {
    const out = parse({
      oxygen_saturation: [
        { time: "2026-06-15T08:00:00Z", percentage: 900 },
        { time: "2026-06-15T09:00:00Z", percentage: 97 },
      ],
    });
    expect(out.vitals).toHaveLength(1);
    expect(out.vitals[0].value_num).toBe(97);
    expect(out.skipped).toBe(1);
  });

  it("rejects a year-3000 timestamp as out of the sanity window", () => {
    const out = parse({
      weight: [{ time: "3000-01-01T08:00:00Z", kilograms: 80 }],
    });
    expect(out.bodyMetrics).toHaveLength(0);
    expect(out.skipped).toBe(1);
  });

  it("rejects a pre-1900 timestamp", () => {
    const out = parse({
      weight: [{ time: "1850-01-01T08:00:00Z", kilograms: 80 }],
    });
    expect(out.bodyMetrics).toHaveLength(0);
    expect(out.skipped).toBe(1);
  });

  it("drops an absurd continuous-HR sample from its minute bucket", () => {
    const out = parse({
      heart_rate: [
        { time: "2026-06-15T08:00:10Z", bpm: 60 },
        { time: "2026-06-15T08:00:40Z", bpm: 9000 }, // sensor fault
      ],
    });
    expect(out.hrMinutes).toHaveLength(1);
    expect(out.hrMinutes[0].bpm).toBe(60); // the 9000 never entered the bucket
    expect(out.hrMinutes[0].n).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it("caps a >24h sleep session as implausible", () => {
    const out = parse({
      sleep: [
        {
          start_time: "2026-06-14T00:00:00Z",
          end_time: "2026-06-16T00:00:00Z", // 48h
        },
      ],
    });
    expect(out.samples).toHaveLength(0);
    expect(out.skipped).toBe(1);
  });

  it("nulls an absurd activity distance without discarding the session", () => {
    const out = parse({
      exercise: [
        {
          type: "Running",
          start_time: "2026-06-15T08:00:00Z",
          end_time: "2026-06-15T09:00:00Z",
          distance_meters: 5_000_000, // 5,000 km — impossible
        },
      ],
    });
    expect(out.activities).toHaveLength(1);
    expect(out.activities[0].distance_km).toBeNull();
    expect(out.activities[0].duration_min).toBe(60);
    expect(out.skipped).toBe(0);
  });
});
