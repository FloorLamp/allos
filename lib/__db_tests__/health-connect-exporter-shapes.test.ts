// DB INTEGRATION TIER — real Health Connect webhook exporter v1.9-shaped fixture
// for #1100/#1101/#1102. Drives the token-authenticated route so parser vocabulary,
// origin persistence, moving-end idempotency, daily reconciliation, and sync-event
// accounting are covered together.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";
import { getMetricDailyTotals } from "@/lib/queries";
import { setTimezone } from "@/lib/settings";

const DATE = "2026-07-20";
let profileId: number;
let token: string;

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

async function post(body: object) {
  return POST(
    new Request("http://x/api/integrations/health-connect/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
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
});

describe("Health Connect exporter v1.9 shapes", () => {
  it("lands HR/HRV/origins and updates a moving-end snapshot in place", async () => {
    expect((await post(payload(`${DATE}T12:00:00Z`, 4000))).status).toBe(200);

    const hr = db
      .prepare(
        `SELECT bpm, bpm_min, bpm_max, n FROM hr_minutes
          WHERE profile_id = ? AND ts = ?`
      )
      .get(profileId, `${DATE}T08:42`);
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
          `SELECT end_time, value FROM metric_samples
            WHERE profile_id = ? AND metric = 'steps'`
        )
        .all(profileId)
    ).toEqual([{ end_time: `${DATE}T20:00:00Z`, value: 8000 }]);

    const event = db
      .prepare(
        `SELECT inserted, updated, unchanged, skipped, details
           FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'health-connect'
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
      warnings: [],
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
