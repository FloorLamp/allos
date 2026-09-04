// DB INTEGRATION TIER — real Health Connect webhook exporter v1.9-shaped fixture
// for #1100/#1101/#1102. Drives the token-authenticated route so parser vocabulary,
// origin persistence, moving-end idempotency, daily reconciliation, and sync-event
// accounting are covered together.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";
import {
  KNOWN_HEALTH_CONNECT_KEYS,
  parseHealthConnectPayload,
} from "@/lib/integrations/health-connect";
import { getMetricDailyTotals } from "@/lib/queries";
import { setTimezone } from "@/lib/settings";

const DATE = "2026-07-20";
let profileId: number;
let token: string;
// The v1.9.17 push goes to its OWN profile so the store reads below see that payload
// and nothing else — the v1.9.14 fixture writes an hrv_ms row too, and a shared
// profile would let either test's rows satisfy the other's assertion.
let v17ProfileId: number;
let v17Token: string;

function payload(stepEnd: string, steps: number) {
  return {
    timestamp: `${DATE}T20:00:05Z`,
    app_version: "1.9.14-test",
    steps: [
      {
        count: steps,
        start_time: `${DATE}T04:00:00Z`,
        end_time: stepEnd,
        metadata: { data_origin: "com.fitbit.FitbitMobile" },
      },
    ],
    total_calories: [
      {
        calories: 470,
        start_time: `${DATE}T04:00:00Z`,
        end_time: `${DATE}T20:00:00Z`,
        metadata: { data_origin: "com.garmin.android.apps.connectmobile" },
      },
      {
        calories: 19.5,
        start_time: `${DATE}T08:00:00Z`,
        end_time: `${DATE}T08:15:00Z`,
        metadata: { data_origin: "com.fitbit.FitbitMobile" },
      },
      {
        calories: 12.9,
        start_time: `${DATE}T08:15:00Z`,
        end_time: `${DATE}T08:30:00Z`,
        metadata: { data_origin: "com.fitbit.FitbitMobile" },
      },
    ],
    heart_rate: [
      {
        time: `${DATE}T08:42:00Z`,
        avg: 84,
        min: 83,
        max: 85,
        metadata: { data_origin: "com.fitbit.FitbitMobile" },
      },
    ],
    heart_rate_variability: [
      {
        time: `${DATE}T09:05:00Z`,
        rmssd_millis: 62.6,
        metadata: { data_origin: "com.fitbit.FitbitMobile" },
      },
    ],
  };
}

// ---- exporter v1.9.17: the BUCKETED shape, every consumed key ----
//
// v1.9.17 (2026-08-28) defaulted all five sample-series types to 1-minute buckets, and
// a bucketed record carries `avg`/`min`/`max` in place of its raw field — spelled
// `avg_delta_celsius`/`min_`/`max_` for skin temperature, which is the exception the
// parser has to know about. Field names here are VERBATIM from the exporter's
// SyncManager.kt at v1.9.17 (`buildJsonPayload`, the `if (x.min != null)` branches);
// the values are synthetic.
//
// It carries a landing record for EVERY key in KNOWN_HEALTH_CONNECT_KEYS, not only the
// five that changed, because that is the property the coverage test below asserts: a
// consumed type with no fixture record fails CI instead of joining the next silent
// drop. #4956 cost six days and 405 `ok` pushes for want of exactly that.
const V17_DAY = "2026-08-30";
const V17_PAYLOAD = {
  timestamp: `${V17_DAY}T21:00:00Z`,
  app_version: "1.9.17-test",
  // The five sample series, all bucketed. avg == min == max is what prod's phone
  // actually sends at 1-minute granularity for a slow-moving series.
  heart_rate: [{ time: `${V17_DAY}T08:42:00Z`, avg: 71, min: 66, max: 78 }],
  heart_rate_variability: [
    { time: `${V17_DAY}T09:05:00Z`, avg: 54, min: 54, max: 54 },
  ],
  oxygen_saturation: [
    { time: `${V17_DAY}T09:06:00Z`, avg: 97, min: 97, max: 97 },
  ],
  respiratory_rate: [
    { time: `${V17_DAY}T09:07:00Z`, avg: 14, min: 14, max: 14 },
  ],
  skin_temperature: [
    {
      time: `${V17_DAY}T01:30:00Z`,
      avg_delta_celsius: -0.4,
      min_delta_celsius: -0.4,
      max_delta_celsius: -0.4,
      baseline_celsius: 33.2,
      measurement_location: "finger",
    },
  ],
  // Everything else the parser consumes, in the shapes v1.9.17 still sends them in.
  weight: [{ time: `${V17_DAY}T07:00:00Z`, kilograms: 71.5 }],
  body_fat: [{ time: `${V17_DAY}T07:01:00Z`, percentage: 22 }],
  resting_heart_rate: [{ time: `${V17_DAY}T07:02:00Z`, bpm: 58 }],
  steps: [
    {
      count: 6200,
      start_time: `${V17_DAY}T04:00:00Z`,
      end_time: `${V17_DAY}T20:00:00Z`,
    },
  ],
  distance: [
    {
      meters: 4300,
      start_time: `${V17_DAY}T04:00:00Z`,
      end_time: `${V17_DAY}T20:00:00Z`,
    },
  ],
  active_calories: [
    {
      calories: 380,
      start_time: `${V17_DAY}T09:00:00Z`,
      end_time: `${V17_DAY}T09:45:00Z`,
    },
  ],
  total_calories: [
    {
      calories: 2100,
      start_time: `${V17_DAY}T04:00:00Z`,
      end_time: `${V17_DAY}T20:00:00Z`,
    },
  ],
  hydration: [
    {
      liters: 1.8,
      start_time: `${V17_DAY}T04:00:00Z`,
      end_time: `${V17_DAY}T20:00:00Z`,
    },
  ],
  nutrition: [
    {
      calories: 640,
      protein_grams: 32,
      start_time: `${V17_DAY}T12:00:00Z`,
      end_time: `${V17_DAY}T12:30:00Z`,
    },
  ],
  lean_body_mass: [{ time: `${V17_DAY}T07:03:00Z`, kilograms: 55.4 }],
  bone_mass: [{ time: `${V17_DAY}T07:04:00Z`, kilograms: 3.1 }],
  basal_metabolic_rate: [{ time: `${V17_DAY}T07:05:00Z`, watts: 78 }],
  height: [{ time: `${V17_DAY}T07:06:00Z`, meters: 1.74 }],
  blood_pressure: [
    { time: `${V17_DAY}T07:07:00Z`, systolic: 118, diastolic: 76 },
  ],
  blood_glucose: [{ time: `${V17_DAY}T07:08:00Z`, mmol_per_liter: 5.2 }],
  body_temperature: [{ time: `${V17_DAY}T07:09:00Z`, celsius: 36.7 }],
  vo2_max: [{ time: `${V17_DAY}T07:10:00Z`, ml_per_kg_per_min: 44 }],
  sleep: [
    {
      start_time: `${V17_DAY}T22:30:00Z`,
      end_time: `2026-08-31T06:30:00Z`,
      stages: [
        {
          stage: "deep",
          start_time: `${V17_DAY}T23:00:00Z`,
          end_time: `2026-08-31T00:30:00Z`,
        },
      ],
    },
  ],
  exercise: [
    {
      type: "running",
      start_time: `${V17_DAY}T09:00:00Z`,
      end_time: `${V17_DAY}T09:45:00Z`,
      duration_seconds: 2700,
    },
  ],
};

async function post(body: object, bearer = token) {
  return POST(
    new Request("http://x/api/integrations/health-connect/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-EXPORTER')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  token = generateHealthConnectToken(profileId, "never");
  v17ProfileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-EXPORTER-17')").run()
      .lastInsertRowid
  );
  setTimezone(v17ProfileId, "UTC");
  v17Token = generateHealthConnectToken(v17ProfileId, "never");
});

describe("Health Connect exporter v1.9 shapes", () => {
  it("lands HR/HRV/origins and updates a moving-end snapshot in place", async () => {
    expect((await post(payload(`${DATE}T12:00:00Z`, 4000))).status).toBe(200);

    const hr = db
      .prepare(
        `SELECT bpm, bpm_min, bpm_max, n FROM hr_minutes
          WHERE profile_id = ? AND ts = ?`
      )
      // The bucket key is the SAMPLE's own UTC minute since #2205 / migration 164,
      // so it matches the pushed instant exactly rather than a zone-shifted one.
      .get(profileId, `${DATE}T08:42:00Z`);
    expect(hr).toEqual({ bpm: 84, bpm_min: 83, bpm_max: 85, n: 1 });
    expect(
      db
        .prepare(
          `SELECT value, origin FROM metric_samples
            WHERE profile_id = ? AND metric = 'hrv_ms'`
        )
        .get(profileId)
    ).toEqual({ value: 62.6, origin: "com.fitbit.FitbitMobile" });
    expect(getMetricDailyTotals(profileId, "total_kcal")).toEqual([
      { date: DATE, value: 470 },
    ]);

    expect((await post(payload(`${DATE}T20:00:00Z`, 8000))).status).toBe(200);
    expect(
      db
        .prepare(
          `SELECT ended_at, value FROM metric_samples
            WHERE profile_id = ? AND metric = 'steps'`
        )
        .all(profileId)
    ).toEqual([{ ended_at: `${DATE}T20:00:00Z`, value: 8000 }]);

    const event = db
      .prepare(
        `SELECT inserted, updated, unchanged, skipped, details
           FROM integration_sync_events
          WHERE profile_id = ? AND source_id = 'health-connect'
          ORDER BY id DESC LIMIT 1`
      )
      .get(profileId) as {
      inserted: number;
      updated: number;
      unchanged: number;
      skipped: number;
      details: string;
    };
    expect(event).toMatchObject({
      inserted: 0,
      updated: 1,
      unchanged: 5,
      skipped: 0,
    });
    expect(JSON.parse(event.details)).toMatchObject({
      // The fixture's Fitbit total_calories stream is deliberately two 15-minute
      // buckets (against Garmin's one day-spanning record) so the origin-dedup case
      // below has something to choose between — which is a genuinely fine-grained
      // shape, and the narrow-window signal now says so. The hint is
      // informational: it changes nothing about the counts or the origin choice
      // asserted here.
      warnings: [
        "Total calories look like a fine-grained setting — set Total calories to `daily` in the webhook app (large payloads risk rejection).",
      ],
      origins: [
        {
          metric: "total_kcal",
          chosen: "com.garmin.android.apps.connectmobile",
          ignored: ["com.fitbit.FitbitMobile"],
        },
      ],
    });
  });
});

describe("Health Connect exporter v1.9.17 bucketed shapes (#4956)", () => {
  it("lands every bucketed sample series, skips nothing, and warns about nothing", async () => {
    expect((await post(V17_PAYLOAD, v17Token)).status).toBe(200);

    // The three types prod lost, plus SpO2, read back from their real stores. The
    // bucketed `avg` is the stored value; `min`/`max` are the bucket's spread and only
    // heart rate has a store shaped to keep them.
    expect(
      db
        .prepare(
          `SELECT metric, value FROM metric_samples
            WHERE profile_id = ? AND metric IN ('hrv_ms', 'skin_temp_delta_c')
            ORDER BY metric`
        )
        .all(v17ProfileId)
    ).toEqual([
      { metric: "hrv_ms", value: 54 },
      { metric: "skin_temp_delta_c", value: -0.4 },
    ]);
    expect(
      db
        .prepare(
          `SELECT canonical_name, value_num FROM medical_records
            WHERE profile_id = ?
              AND canonical_name IN ('Respiratory Rate', 'Oxygen Saturation')
            ORDER BY canonical_name`
        )
        .all(v17ProfileId)
    ).toEqual([
      { canonical_name: "Oxygen Saturation", value_num: 97 },
      { canonical_name: "Respiratory Rate", value_num: 14 },
    ]);
    expect(
      db
        .prepare(
          `SELECT bpm, bpm_min, bpm_max FROM hr_minutes
            WHERE profile_id = ? AND ts = ?`
        )
        .get(v17ProfileId, `${V17_DAY}T08:42:00Z`)
    ).toEqual({ bpm: 71, bpm_min: 66, bpm_max: 78 });

    const event = db
      .prepare(
        `SELECT skipped, details FROM integration_sync_events
           WHERE profile_id = ? AND source_id = 'health-connect'
           ORDER BY id DESC LIMIT 1`
      )
      .get(v17ProfileId) as { skipped: number; details: string };
    expect(event.skipped).toBe(0);
    expect(JSON.parse(event.details).warnings).toEqual([]);
    // The tally is the durable per-type receipt the `dropping` row reads back.
    expect(JSON.parse(event.details).tally).toMatchObject({
      heart_rate_variability: { received: 1, landed: 1 },
      respiratory_rate: { received: 1, landed: 1 },
      skin_temperature: { received: 1, landed: 1 },
      oxygen_saturation: { received: 1, landed: 1 },
      heart_rate: { received: 1, landed: 1 },
    });
  });

  // Both fixtures, one assertion: the shape the exporter sends TODAY and the raw shape
  // it sent before it started bucketing must both come through clean. A reader that
  // fixed the new shape by breaking the old one passes every other test here.
  //
  // The warning check names the ALL-SKIPPED signature rather than asserting an empty
  // list: the v1.9.14 fixture legitimately carries a #1065 granularity HINT (its
  // deliberate two-bucket Fitbit calorie stream), and folding that into "no warnings"
  // would make this pass for the wrong reason the day a real drop appeared beside it.
  it.each([
    ["v1.9.17 bucketed", V17_PAYLOAD],
    ["v1.9.14 raw", payload(`${DATE}T12:00:00Z`, 4000)],
  ])("%s parses with nothing skipped and nothing dropped", (_label, body) => {
    const out = parseHealthConnectPayload(body, "UTC");
    expect(out.skipped).toBe(0);
    expect(
      out.details.warnings.filter((w) => w.includes("were all skipped"))
    ).toEqual([]);
  });

  // THE PREVENTION HALF. A key the parser consumes but no fixture exercises is exactly
  // the state HRV, respiratory rate and skin temperature were in when v1.9.17 shipped:
  // covered in principle, unproven in fact. The tally makes "did a record of this type
  // actually land" a question the fixture can answer for every key at once, so adding a
  // consumed key without a fixture record fails here rather than on someone's phone.
  it("carries a landing record for every consumed payload key", () => {
    const { tally } = parseHealthConnectPayload(V17_PAYLOAD, "UTC").details;
    const uncovered = [...KNOWN_HEALTH_CONNECT_KEYS].filter(
      (key) => !((tally[key]?.landed ?? 0) > 0)
    );
    expect(uncovered).toEqual([]);
  });
});
