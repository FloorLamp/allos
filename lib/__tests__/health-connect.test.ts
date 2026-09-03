import { describe, expect, it } from "vitest";
import {
  parseHealthConnectPayload,
  countUnknownRecords,
  detectGranularityHints,
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
      glucoseTrace: [],
      skipped: 0,
      details: { warnings: [], origins: [], tally: {} },
      pushedAt: null,
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
    // Each measure carries ITS OWN instant (#3524) — here the instant of the weight
    // that won its day, not of the day's latest reading of any kind. The ingest reconcile
    // asks the day arithmetic one measure at a time, so a stamp that belonged to a
    // different measure would re-key the wrong thing.
    expect(out.bodyMetrics).toEqual([
      {
        date: "2026-06-15",
        partial_day: true,
        weight_kg: 81,
        weight_at: "2026-06-15T20:00:00Z",
      },
      {
        date: "2026-06-16",
        weight_kg: 82,
        weight_at: "2026-06-16T08:00:00Z",
      },
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
      {
        date: "2026-06-15",
        weight_kg: 80,
        body_fat_pct: 18.5,
        resting_hr: 59,
        // Three readings, one row, THREE stamps. The 07:00 weigh-in keeps 07:00 — the
        // conflation this replaces would have called it 08:00, which is how an earlier
        // draft of the reconcile came to destroy a weigh-in while re-keying a
        // resting-HR reading (#3524).
        weight_at: "2026-06-15T07:00:00Z",
        body_fat_at: "2026-06-15T08:00:00Z",
        resting_hr_at: "2026-06-15T08:00:00Z",
      },
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
      {
        date: "2026-06-16",
        body_fat_pct: 20,
        resting_hr: 62,
        body_fat_at: "2026-06-16T08:00:00Z",
        // The LATEST reading that contributed to the average, for the two measures that
        // ARE averaged — the day's resting HR is 06:00 and 07:00 folded together.
        resting_hr_at: "2026-06-16T07:00:00Z",
      },
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
    expect(out.bodyMetrics).toEqual([
      {
        date: "2026-06-16",
        resting_hr: 62,
        resting_hr_at: "2026-06-16T21:00:00Z",
      },
    ]);
  });
});

describe("parseHealthConnectPayload — metric samples", () => {
  it("links active energy to the exercise's stable provider identity", () => {
    const out = parse({
      exercise: [
        {
          type: "running",
          start_time: "2026-06-15T07:00:00Z",
          end_time: "2026-06-15T08:00:00Z",
        },
      ],
      active_calories: [
        {
          start_time: "2026-06-15T07:00:00Z",
          end_time: "2026-06-15T08:00:00Z",
          calories: 0,
        },
      ],
    });
    expect(out.samples).toContainEqual(
      expect.objectContaining({
        metric: "active_kcal",
        value: 0,
        activity_external_id: "health-connect:2026-06-15T07:00:00Z",
      })
    );
  });

  it("does not link an energy interval that only shares the exercise start", () => {
    const out = parse({
      exercise: [
        {
          type: "running",
          start_time: "2026-06-15T07:00:00Z",
          end_time: "2026-06-15T08:00:00Z",
        },
      ],
      active_calories: [
        {
          start_time: "2026-06-15T07:00:00Z",
          end_time: "2026-06-15T07:30:00Z",
          calories: 240,
        },
      ],
    });
    expect(out.samples).toContainEqual(
      expect.objectContaining({
        metric: "active_kcal",
        activity_external_id: null,
      })
    );
  });

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
    // #1076: Glucose is a lab, not a vital sign — stays on the lab list.
    expect(glucose.category).toBe("lab");
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
    const first = out.hrMinutes.find((m) => m.ts === "2026-06-15T08:00:00Z")!;
    expect(first.bpm).toBe(70); // (60 + 80) / 2
    expect(first.bpm_min).toBe(60);
    expect(first.bpm_max).toBe(80);
    expect(first.n).toBe(2);
  });

  it("accepts the exporter v1.9 minute avg/min/max and rmssd_millis shapes (#1100)", () => {
    const out = parse({
      heart_rate: [
        {
          time: "2026-06-15T08:00:00Z",
          avg: 84,
          min: 83,
          max: 85,
          metadata: { data_origin: "com.fitbit.FitbitMobile" },
        },
      ],
      heart_rate_variability: [
        {
          time: "2026-06-15T09:05:00Z",
          rmssd_millis: 62.6,
          metadata: { data_origin: "com.fitbit.FitbitMobile" },
        },
        { time: "2026-06-15T10:05:00Z", milliseconds: 48 },
      ],
    });
    expect(out.hrMinutes).toEqual([
      { ts: "2026-06-15T08:00:00Z", bpm: 84, bpm_min: 83, bpm_max: 85, n: 1 },
    ]);
    expect(out.samples).toContainEqual(
      expect.objectContaining({
        metric: "hrv_ms",
        value: 62.6,
        origin: "com.fitbit.FitbitMobile",
      })
    );
    expect(out.samples).toContainEqual(
      expect.objectContaining({ metric: "hrv_ms", value: 48, origin: null })
    );
    expect(out.skipped).toBe(0);
  });

  it.each([
    ["heart_rate", { time: "2026-06-15T08:00:00Z", renamed_average: 84 }],
    ["heart_rate_variability", { time: "2026-06-15T08:00:00Z", renamed: 62 }],
    // The three the OLD code could not diagnose: only heart rate and HRV carried a
    // hand-placed warning, so respiratory rate, SpO2 and skin temperature dropped in
    // total silence when v1.9.17 renamed their fields (#4956). The diagnosis is now
    // derived from the per-type tally, so it covers every consumed type by
    // construction rather than by anyone having remembered to write it.
    ["respiratory_rate", { time: "2026-06-15T08:00:00Z", renamed: 14 }],
    ["oxygen_saturation", { time: "2026-06-15T08:00:00Z", renamed: 97 }],
    ["skin_temperature", { time: "2026-06-15T08:00:00Z", renamed: -0.4 }],
  ])(
    "diagnoses %s when its whole batch has an unknown shape",
    (key, record) => {
      const out = parse({ [key]: [record] });
      expect(out.skipped).toBe(1);
      expect(out.details.tally[key]).toEqual({ received: 1, landed: 0 });
      expect(out.details.warnings).toEqual([
        `${key} records were all skipped — exporter shape not recognized`,
      ]);
    }
  );

  // The converse, and it is the half a warning-only guard cannot state: a type that
  // PARTLY lands is not a dropped type, and must stay quiet. A tally that reported
  // `landed: 0` whenever anything was skipped would pass every case above while
  // crying wolf on the ordinary out-of-range reading.
  it("stays quiet for a type that lands some of its records", () => {
    const out = parse({
      respiratory_rate: [
        { time: "2026-06-15T08:00:00Z", avg: 14, min: 14, max: 14 },
        { time: "2026-06-15T08:01:00Z", renamed: 15 },
      ],
    });
    expect(out.skipped).toBe(1);
    expect(out.details.tally.respiratory_rate).toEqual({
      received: 2,
      landed: 1,
    });
    expect(out.details.warnings).toEqual([]);
  });

  // The exporter's two shapes, per type, in one table (#4956). The bucketed column is
  // what v1.9.17 defaults every sample series to; the raw column is what it sent
  // before, and both must land the same value through the same reader.
  it.each([
    [
      "heart_rate_variability",
      { rmssd_millis: 54 },
      { avg: 54, min: 54, max: 54 },
    ],
    ["oxygen_saturation", { percentage: 97 }, { avg: 97, min: 97, max: 97 }],
    ["respiratory_rate", { rate: 14 }, { avg: 14, min: 14, max: 14 }],
    [
      "skin_temperature",
      { delta_celsius: -0.4 },
      {
        avg_delta_celsius: -0.4,
        min_delta_celsius: -0.4,
        max_delta_celsius: -0.4,
      },
    ],
    ["heart_rate", { bpm: 71 }, { avg: 71, min: 71, max: 71 }],
  ])("reads both exporter shapes of %s", (key, raw, bucketed) => {
    for (const shape of [raw, bucketed]) {
      const out = parse({
        [key]: [{ time: "2026-06-15T08:00:00Z", ...shape }],
      });
      expect(out.details.tally[key]).toEqual({ received: 1, landed: 1 });
      expect(out.skipped).toBe(0);
      expect(out.details.warnings).toEqual([]);
    }
  });
});

describe("parseHealthConnectPayload — Health Connect origins", () => {
  it("carries metadata.data_origin and reports the largest additive origin", () => {
    const out = parse({
      total_calories: [
        {
          start_time: "2026-06-15T00:00:00Z",
          end_time: "2026-06-15T12:00:00Z",
          calories: 470,
          metadata: { data_origin: "com.garmin.android.apps.connectmobile" },
        },
        {
          start_time: "2026-06-15T08:00:00Z",
          end_time: "2026-06-15T08:15:00Z",
          calories: 19.5,
          metadata: { data_origin: "com.fitbit.FitbitMobile" },
        },
        {
          start_time: "2026-06-15T08:15:00Z",
          end_time: "2026-06-15T08:30:00Z",
          calories: 12.9,
          metadata: { data_origin: "com.fitbit.FitbitMobile" },
        },
      ],
    });
    expect(out.samples.map((sample) => sample.origin)).toEqual([
      "com.garmin.android.apps.connectmobile",
      "com.fitbit.FitbitMobile",
      "com.fitbit.FitbitMobile",
    ]);
    expect(out.details.origins).toEqual([
      {
        date: "2026-06-15",
        metric: "total_kcal",
        chosen: "com.garmin.android.apps.connectmobile",
        ignored: ["com.fitbit.FitbitMobile"],
      },
    ]);
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

  // Real exporter builds send `type` as the AndroidX enum int's toString() — the same
  // convention the sleep-stage parser already handles — so a Fitbit "other workout"
  // arrives as "0" and used to import as a sport literally titled "0" (the Fitbit-exporter payload audit).
  it("resolves numeric AndroidX exercise types to their names", () => {
    const out = parse({
      exercise: [
        { type: "0", start_time: "2026-06-15T06:00:00Z" }, // OTHER_WORKOUT
        { type: "56", start_time: "2026-06-15T07:00:00Z" }, // RUNNING
        { type: "8", start_time: "2026-06-15T08:00:00Z" }, // BIKING
        { type: "70", start_time: "2026-06-15T09:00:00Z" }, // STRENGTH_TRAINING
      ],
    });
    // "0" is EXERCISE_TYPE_OTHER_WORKOUT — "a workout, unspecified". That is a stated
    // ABSENCE, so the row says so (#2272) instead of asserting a `sport` no provider
    // ever claimed. The three real types are unaffected.
    expect(out.activities.map((a) => [a.title, a.type])).toEqual([
      ["Workout", "unclassified"],
      ["Running", "cardio"],
      ["Biking", "cardio"],
      ["Strength Training", "sport"],
    ]);
  });

  // A constant from a newer library version must not become an activity named "91".
  it("falls back to the generic title for an unmapped numeric type", () => {
    const out = parse({
      exercise: [{ type: "91", start_time: "2026-06-15T06:00:00Z" }],
    });
    expect(out.activities[0].title).toBe("Workout");
    // A constant this build cannot read is also a source that said nothing we can use.
    expect(out.activities[0].type).toBe("unclassified");
  });

  // The numeric and string spellings share one code path, so they must agree.
  it("classifies the numeric and string spellings of a type identically", () => {
    const numeric = parse({
      exercise: [{ type: "79", start_time: "2026-06-15T06:00:00Z" }],
    }).activities[0];
    const string = parse({
      exercise: [{ type: "walking", start_time: "2026-06-15T06:00:00Z" }],
    }).activities[0];
    expect([numeric.title, numeric.type]).toEqual([string.title, string.type]);
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

  // Numeric stage constants — the shape every real exporter build sends.
  it("classifies numeric AndroidX stage constants", () => {
    const out = parse({
      sleep: [
        {
          session_end_time: "2026-06-15T07:00:00Z",
          duration_seconds: 7200,
          stages: [
            { stage: "4", duration_seconds: 3600 }, // LIGHT
            { stage: "5", duration_seconds: 1800 }, // DEEP
            { stage: "6", duration_seconds: 1200 }, // REM
            { stage: "1", duration_seconds: 600 }, // AWAKE
          ].map((st, i) => ({
            ...st,
            start_time: `2026-06-15T0${i}:00:00Z`,
            end_time: `2026-06-15T0${i}:30:00Z`,
          })),
        },
      ],
    });
    const byMetric = (m: string) =>
      out.samples
        .filter((s) => s.metric === m)
        .reduce((a, s) => a + s.value, 0);
    expect(byMetric("sleep_light_min")).toBe(60);
    expect(byMetric("sleep_deep_min")).toBe(30);
    expect(byMetric("sleep_rem_min")).toBe(20);
    expect(byMetric("sleep_awake_min")).toBe(10);
  });

  // A real wrist-tracker night is dozens of stages, many of them 30 seconds long.
  // Rounding each to a whole minute at ingest made the breakdown out-sum the session
  // it belongs to (a 62-stage Fitbit night stored 391 min against 377) — so stages are
  // stored exact and rounded once, later, on the summed day total (the Fitbit-exporter payload audit).
  it("keeps the stage breakdown summing to the session total", () => {
    const stage = (
      s: string,
      startMin: number,
      lengthSec: number
    ): Record<string, unknown> => {
      const base = Date.UTC(2026, 5, 15, 3, 0, 0) + startMin * 60_000;
      return {
        stage: s,
        start_time: new Date(base).toISOString(),
        end_time: new Date(base + lengthSec * 1000).toISOString(),
        duration_seconds: lengthSec,
      };
    };
    const out = parse({
      sleep: [
        {
          session_end_time: "2026-06-15T04:00:00Z",
          duration_seconds: 3600,
          stages: [
            stage("4", 0, 1770), // light, 29.5 min
            stage("1", 29.5, 30), // awake, 30 s
            stage("5", 30, 1770), // deep, 29.5 min
            stage("1", 59.5, 30), // awake, 30 s
          ],
        },
      ],
    });
    const total = out.samples.find((s) => s.metric === "sleep_min")!.value;
    const stageSum = out.samples
      .filter((s) => s.metric.startsWith("sleep_") && s.metric !== "sleep_min")
      .reduce((a, s) => a + s.value, 0);
    expect(total).toBe(60);
    // Per-stage rounding would have made this 62 (29.5→30 twice, 0.5→1 twice).
    expect(stageSum).toBe(60);
  });

  // Storage precision is bounded so a re-sent window stays byte-identical and the
  // SELECT-before-compare upsert still counts it `unchanged` (the #1109 discipline).
  it("bounds stored stage precision to 2dp", () => {
    const out = parse({
      sleep: [
        {
          session_end_time: "2026-06-15T04:00:00Z",
          duration_seconds: 47,
          stages: [
            {
              stage: "5",
              start_time: "2026-06-15T03:59:13Z",
              end_time: "2026-06-15T04:00:00Z",
              duration_seconds: 47,
            },
          ],
        },
      ],
    });
    // 47 s = 0.78333… min → stored as 0.78, not a 17-digit float.
    expect(out.samples.find((s) => s.metric === "sleep_deep_min")!.value).toBe(
      0.78
    );
  });

  // The window is the only duration source when a build omits duration_seconds; it
  // must not be quantized to whole minutes on the way in.
  it("derives exact stage seconds when duration_seconds is absent", () => {
    const out = parse({
      sleep: [
        {
          session_end_time: "2026-06-15T04:00:00Z",
          duration_seconds: 60,
          stages: [
            {
              stage: "1",
              start_time: "2026-06-15T03:59:30Z",
              end_time: "2026-06-15T04:00:00Z",
            },
          ],
        },
      ],
    });
    expect(out.samples.find((s) => s.metric === "sleep_awake_min")!.value).toBe(
      0.5
    );
  });
});

describe("parseHealthConnectPayload — skin temperature variation", () => {
  it("routes the signed delta to metric_samples, not the Body Temperature vital", () => {
    const out = parse({
      skin_temperature: [
        {
          time: "2026-06-15T03:23:00Z",
          delta_celsius: 0.6,
          measurement_location: 0,
          metadata: { data_origin: "com.fitbit.FitbitMobile" },
        },
      ],
    });
    expect(out.samples).toEqual([
      {
        metric: "skin_temp_delta_c",
        date: "2026-06-15",
        started_at: "2026-06-15T03:23:00Z",
        ended_at: "2026-06-15T03:23:00Z",
        value: 0.6,
        origin: "com.fitbit.FitbitMobile",
      },
    ]);
    // It must NOT become a reference-range-flagged vital: 0.6 against a 97–99 °F
    // envelope would read as catastrophically abnormal.
    expect(out.vitals).toEqual([]);
    expect(out.skipped).toBe(0);
  });

  // A tracker stamps the nightly reading at sleep ONSET, which is usually before local
  // midnight — while the night's sleep total and HRV land on the WAKE day. Left on its
  // own date the same night's skin temperature would chart one day to the left.
  it("borrows the containing sleep session's wake day", () => {
    const out = parse(
      {
        sleep: [
          {
            session_end_time: "2026-06-15T11:00:00Z", // 07:00 local
            duration_seconds: 8 * 3600, // onset 03:00Z = 23:00 local, previous day
          },
        ],
        skin_temperature: [
          { time: "2026-06-15T03:23:00Z", delta_celsius: 0.6 },
        ],
      },
      "America/New_York"
    );
    const skin = out.samples.find((s) => s.metric === "skin_temp_delta_c")!;
    const sleep = out.samples.find((s) => s.metric === "sleep_min")!;
    // Its own local date would be 2026-06-14 (23:23 the previous evening).
    expect(skin.date).toBe("2026-06-15");
    expect(skin.date).toBe(sleep.date);
  });

  it("falls back to its own local date when the push carries no sleep session", () => {
    const out = parse(
      {
        skin_temperature: [
          { time: "2026-06-15T03:23:00Z", delta_celsius: 0.6 },
        ],
      },
      "America/New_York"
    );
    expect(out.samples[0].date).toBe("2026-06-14");
  });

  // Two consecutive nights whose onsets straddle local midnight share a calendar date.
  // Without the session anchor the per-day AVG would merge them into one point.
  it("keeps two nights apart when their onsets straddle midnight", () => {
    const out = parse(
      {
        sleep: [
          {
            session_end_time: "2026-06-15T11:00:00Z",
            duration_seconds: 8 * 3600, // onset 2026-06-15T03:00Z → 23:00 local 06-14
          },
          {
            session_end_time: "2026-06-16T11:00:00Z",
            duration_seconds: 7 * 3600, // onset 2026-06-16T04:00Z → 00:00 local 06-16
          },
        ],
        skin_temperature: [
          { time: "2026-06-15T03:30:00Z", delta_celsius: 0.6 },
          { time: "2026-06-16T04:30:00Z", delta_celsius: -0.2 },
        ],
      },
      "America/New_York"
    );
    const skin = out.samples
      .filter((s) => s.metric === "skin_temp_delta_c")
      .map((s) => [s.date, s.value]);
    expect(skin).toEqual([
      ["2026-06-15", 0.6],
      ["2026-06-16", -0.2],
    ]);
  });

  // A cool night is the normal case, so the signed value has to survive ingest.
  it("keeps a negative delta", () => {
    const out = parse({
      skin_temperature: [{ time: "2026-06-15T02:59:00Z", delta_celsius: -0.1 }],
    });
    expect(out.samples[0].value).toBe(-0.1);
  });

  it("drops a sensor-fault delta outside the plausibility envelope", () => {
    const out = parse({
      skin_temperature: [{ time: "2026-06-15T02:59:00Z", delta_celsius: 900 }],
    });
    expect(out.samples).toEqual([]);
    expect(out.skipped).toBe(1);
  });

  // It used to be the one record type that always counted as an unknown drop.
  it("no longer counts as an unknown record type", () => {
    expect(
      countUnknownRecords({
        skin_temperature: [
          { time: "2026-06-15T02:59:00Z", delta_celsius: 0.2 },
        ],
      })
    ).toBe(0);
  });
});

describe("detectGranularityHints — fine-grained settings (#1065)", () => {
  const kcal = (startIso: string, endIso: string) => ({
    start_time: startIso,
    end_time: endIso,
    calories: 20,
  });

  it("flags a whole-day push carrying many sub-daily rows", () => {
    const recs = Array.from({ length: 10 }, (_, i) =>
      kcal(
        `2026-06-15T${String(i).padStart(2, "0")}:00:00Z`,
        `2026-06-15T${String(i).padStart(2, "0")}:15:00Z`
      )
    );
    expect(detectGranularityHints({ total_calories: recs })).toHaveLength(1);
  });

  // The count signal reads ONE push, but a real exporter is INCREMENTAL: at a `15m`
  // setting it delivers only the 1–2 buckets that changed since the last push and
  // never reaches the 8-row threshold, while the day accumulates ~96 of them (the Fitbit-exporter payload audit).
  it("flags an incremental push of a few narrow windows", () => {
    const hints = detectGranularityHints({
      total_calories: [
        kcal("2026-06-15T09:45:00Z", "2026-06-15T10:00:00Z"),
        kcal("2026-06-15T10:00:00Z", "2026-06-15T10:15:00Z"),
      ],
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("Total calories");
    expect(hints[0]).toContain("`daily`");
  });

  it("does not flag a correctly-set daily push", () => {
    // One day-spanning record per metric — the `daily` shape.
    expect(
      detectGranularityHints({
        steps: [
          {
            start_time: "2026-06-15T00:00:00Z",
            end_time: "2026-06-15T18:00:00Z",
            count: 9000,
          },
        ],
        total_calories: [kcal("2026-06-15T00:00:00Z", "2026-06-15T18:00:00Z")],
      })
    ).toEqual([]);
  });

  it("emits one hint per metric even when both signals fire", () => {
    const recs = Array.from({ length: 12 }, (_, i) =>
      kcal(
        `2026-06-15T${String(i).padStart(2, "0")}:00:00Z`,
        `2026-06-15T${String(i).padStart(2, "0")}:15:00Z`
      )
    );
    expect(detectGranularityHints({ total_calories: recs })).toHaveLength(1);
  });

  it("ignores a single short window (a daily push just after midnight)", () => {
    expect(
      detectGranularityHints({
        steps: [
          {
            start_time: "2026-06-15T00:00:00Z",
            end_time: "2026-06-15T00:20:00Z",
            count: 40,
          },
        ],
      })
    ).toEqual([]);
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
    // The DAY moves with the zone; the INSTANT does not, which is the whole basis of
    // the ingest reconcile (#3524).
    expect(tokyo.bodyMetrics).toEqual([
      {
        date: "2026-06-16",
        weight_kg: 80,
        weight_at: "2026-06-15T23:30:00Z",
      },
    ]);
    expect(tokyo.activities[0].date).toBe("2026-06-16");
    expect(tokyo.activities[0].start_time).toBe("08:30");

    // Same instant in New York (UTC-4 in June) is still the 15th at 19:30.
    const ny = parse(body, "America/New_York");
    expect(ny.bodyMetrics).toEqual([
      {
        date: "2026-06-15",
        weight_kg: 80,
        weight_at: "2026-06-15T23:30:00Z",
      },
    ]);
    expect(ny.activities[0].date).toBe("2026-06-15");
    expect(ny.activities[0].start_time).toBe("19:30");
  });

  it("buckets heart-rate minutes on the SAMPLE's own minute, not the zone's", () => {
    // The bucket key stopped depending on the profile timezone at #2205 / migration
    // 164: `hr_minutes.ts` is the sample's own UTC minute, so the same raw samples
    // bucket identically whatever zone the profile is in. That is the entire point —
    // a timezone change can no longer re-key the rolling window. The profile-local
    // day these belong to (the 16th in Tokyo) is derived at READ time instead.
    const tokyo = parse(
      {
        heart_rate: [
          { time: "2026-06-15T23:00:10Z", bpm: 60 },
          { time: "2026-06-15T23:00:50Z", bpm: 70 },
        ],
      },
      "Asia/Tokyo"
    );
    expect(tokyo.hrMinutes).toHaveLength(1);
    expect(tokyo.hrMinutes[0].ts).toBe("2026-06-15T23:00:00Z");
    expect(tokyo.hrMinutes[0].bpm).toBe(65);

    const ny = parse(
      {
        heart_rate: [
          { time: "2026-06-15T23:00:10Z", bpm: 60 },
          { time: "2026-06-15T23:00:50Z", bpm: 70 },
        ],
      },
      "America/New_York"
    );
    expect(ny.hrMinutes[0].ts).toBe(tokyo.hrMinutes[0].ts);
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
    expect(out.bodyMetrics).toEqual([
      {
        date: "2026-06-16",
        weight_kg: 80,
        weight_at: "2026-06-16T08:00:00Z",
      },
    ]);
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

// ─────────────────────────────────────────────────────────────────────────────
// #3901 — A DAY BUCKET IS FILED UNDER THE DAY ITS OWN ANCHOR NAMES.
//
// The exporter cuts a `daily` record at the DEVICE's local midnight, and the profile's
// zone lags that by hours around every travel switch. Filing the bucket under the
// profile's day let a re-anchored bucket land on its neighbour's date, supersede the
// neighbour's completed row and then walk off the emptied day on the next re-send —
// two prod days of steps, distance and kcal. Every case below passes a profile zone
// that DISAGREES with the anchor, because agreement is what used to hide the bug.
// ─────────────────────────────────────────────────────────────────────────────
describe("day-bucket date derivation (#3901)", () => {
  const bucket = (start: string, end: string, count = 4000) => ({
    steps: [{ start_time: start, end_time: end, count }],
  });

  it.each([
    // The prod sequence: each bucket names its own day whatever the profile holds.
    [
      "HST anchor, profile Honolulu",
      "2026-08-25T10:00:00Z",
      "Pacific/Honolulu",
      "2026-08-25",
    ],
    [
      "LA anchor, profile still Honolulu",
      "2026-08-26T07:00:00Z",
      "Pacific/Honolulu",
      "2026-08-26",
    ],
    [
      "NY anchor, profile still LA",
      "2026-08-27T04:00:00Z",
      "America/Los_Angeles",
      "2026-08-27",
    ],
    // The ambiguous 10:00Z-12:00Z band, pinned from both sides by the profile zone.
    [
      "10:00Z, +14 profile keeps +14",
      "2026-08-25T10:00:00Z",
      "Pacific/Kiritimati",
      "2026-08-26",
    ],
    // A quarter-hour zone: 18:30Z is the Kolkata midnight of the NEXT day.
    ["+05:30 anchor", "2026-08-25T18:30:00Z", "Asia/Kolkata", "2026-08-26"],
  ])("%s", (_name, start, tz, expected) => {
    const out = parse(bucket(start, "2026-08-27T23:00:00Z"), tz);
    expect(out.samples.map((s) => s.date)).toEqual([expected]);
  });

  // THE COMPARISON IS THE POINT, so every row below shares ONE instant chosen to make
  // the two derivations DISAGREE: under America/Los_Angeles (UTC-7 in August)
  // 2026-08-25T04:00Z is 08-24 21:00 local, so the profile attribution is 08-24 — while
  // as an ANCHOR it is a UTC-4 midnight and names 08-25. A test where the two agree
  // cannot tell which one answered.
  //
  // IT IS DELIBERATELY OUTSIDE THE 10:00Z-12:00Z BAND. In that band the derivation defers
  // to the profile's own day by design (#3924), so the two CANNOT disagree there and an
  // ambiguous instant would make this contrast untestable — which is how an earlier
  // version of this case, built on 10:00Z under Asia/Tokyo, came to assert the very
  // mis-derivation the tie-break fix removed.
  const SPLIT = "2026-08-25T04:00:00Z";

  it("files a day-bucket-width steps row under the ANCHOR day", () => {
    const out = parse(
      bucket(SPLIT, "2026-08-25T15:00:00Z"),
      "America/Los_Angeles"
    );
    expect(out.samples.map((s) => s.date)).toEqual(["2026-08-25"]);
  });

  it("keeps the PROFILE attribution for everything that is not a day bucket", () => {
    // A `15m` exporter setting sends the SAME metrics as minute buckets whose start is
    // no midnight at all; hydration, nutrition and sleep sit on their records' real
    // windows and nest legitimately. None of them states an anchor, so all of them keep
    // the day the profile's zone gives them — 08-24, against the day-bucket row's 08-25.
    const out = parse(
      {
        steps: [
          { start_time: SPLIT, end_time: "2026-08-25T04:15:00Z", count: 300 },
        ],
        hydration: [
          { start_time: SPLIT, end_time: "2026-08-25T06:00:00Z", liters: 1.5 },
        ],
        nutrition: [
          {
            start_time: SPLIT,
            end_time: "2026-08-25T06:00:00Z",
            calories: 700,
          },
        ],
        sleep: [{ start_time: SPLIT, end_time: "2026-08-25T06:00:00Z" }],
        // A POINT reading, which has no window to read an anchor off at all.
        heart_rate_variability: [{ time: SPLIT, milliseconds: 40 }],
      },
      "America/Los_Angeles"
    );
    expect(out.samples.map((s) => [s.metric, s.date])).toEqual([
      ["steps", "2026-08-24"],
      ["hydration_l", "2026-08-24"],
      ["nutrition_kcal", "2026-08-24"],
      ["hrv_ms", "2026-08-24"],
      // Sleep is filed on the profile-local WAKE day and always has been: 06:00Z is
      // 08-24 23:00 in Los Angeles. Unchanged by #3901, and the profile's zone decides.
      ["sleep_min", "2026-08-24"],
    ]);
  });
});
