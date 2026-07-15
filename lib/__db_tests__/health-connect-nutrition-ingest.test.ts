// DB INTEGRATION TIER — Health Connect nutrition ingest, end-to-end (issue #770).
//
// Food trackers (MyFitnessPal, Cronometer, Lose It!, Yazio) have no usable direct
// API, so the supported path is: the food app writes dietary records to Health
// Connect, the phone exporter pushes them to the HC ingest endpoint, and the parser
// maps each nutrient to a metric_samples row (protein_grams → protein_g, calories →
// nutrition_kcal, carbs_grams → carbs_g, …). This tier drives a synthetic nutrition
// batch through the REAL ingest write path — token auth → parse → metric_samples
// upsert — and pins the three load-bearing facts:
//   • protein_g + other nutrients land with the right local date and values,
//   • replaying the SAME rolling window is idempotent (unchanged, no doubling),
//   • the daily protein total is readable via getMetricDailyTotals(profileId,
//     "protein_g") — the exact read #767's protein-adequacy gather consumes.
//
// It asserts NO new behavior: the parser/route are unchanged. Runs via
// `npm run test:db`; the `db` singleton points at a per-file temp DB (setup.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";
import { getMetricDailyTotals } from "@/lib/queries";
import { setTimezone } from "@/lib/settings";

let profileId: number;
let token: string;

// UTC timezone so the exporter's absolute instants attribute to an unambiguous
// local day (the parser buckets each instant in the PROFILE's zone, #94).
const TZ = "UTC";
const DATE = "2026-05-10";

// Two logged meals on one day — the food-tracker reality where the day's macros are
// the SUM of several dietary records. Each meal carries a distinct time window (the
// natural dedup key), so it lands as its own metric_samples row per nutrient.
const PAYLOAD = {
  timestamp: `${DATE}T20:00:00Z`,
  app_version: "test",
  nutrition: [
    {
      start_time: `${DATE}T08:00:00Z`,
      end_time: `${DATE}T08:30:00Z`,
      calories: 450,
      protein_grams: 30,
      carbs_grams: 45,
      fat_grams: 15,
    },
    {
      start_time: `${DATE}T19:00:00Z`,
      end_time: `${DATE}T19:30:00Z`,
      calories: 700,
      protein_grams: 50,
      carbs_grams: 60,
      fat_grams: 25,
    },
  ],
};

function post() {
  return POST(
    new Request("http://x/api/integrations/health-connect/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(PAYLOAD),
    })
  );
}

// Latest recorded sync event's insert/update/unchanged split (the idempotency proof).
function latestSplit(): {
  ok: number;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
} {
  return db
    .prepare(
      `SELECT ok, inserted, updated, unchanged FROM integration_sync_events
        WHERE profile_id = ? AND provider = 'health-connect'
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as {
    ok: number;
    inserted: number | null;
    updated: number | null;
    unchanged: number | null;
  };
}

function samplesFor(metric: string): { date: string; value: number }[] {
  return db
    .prepare(
      `SELECT date, value FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'health-connect'
        ORDER BY start_time`
    )
    .all(profileId, metric) as { date: string; value: number }[];
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-NUTRITION')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);
  // Mint a real DB-backed token so the ingest handler resolves this profile from
  // the bearer exactly as in production (token auth is part of the path under test).
  token = generateHealthConnectToken(profileId, "never");
});

describe("Health Connect nutrition ingest — end to end (#770)", () => {
  it("maps macros to metric_samples with the right local date and values", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // protein_grams → protein_g: one row per meal, both on the local day.
    expect(samplesFor("protein_g")).toEqual([
      { date: DATE, value: 30 },
      { date: DATE, value: 50 },
    ]);
    // A second nutrient (carbs) + calories land the same way.
    expect(samplesFor("carbs_g")).toEqual([
      { date: DATE, value: 45 },
      { date: DATE, value: 60 },
    ]);
    expect(samplesFor("nutrition_kcal")).toEqual([
      { date: DATE, value: 450 },
      { date: DATE, value: 700 },
    ]);

    // The whole batch was newly inserted (2 meals × 4 nutrients = 8 samples).
    const split = latestSplit();
    expect(split.ok).toBe(1);
    expect(split.inserted).toBe(8);
    expect(split.unchanged).toBe(0);
  });

  it("the daily protein total is readable via the #767 gather's exact read", () => {
    // getMetricDailyTotals SUMs the day's dietary records (30 + 50 = 80 g) —
    // the tracked basis collectDietaryAdequacy() consumes for protein-adequacy.
    expect(getMetricDailyTotals(profileId, "protein_g")).toEqual([
      { date: DATE, value: 80 },
    ]);
    expect(getMetricDailyTotals(profileId, "carbs_g")).toEqual([
      { date: DATE, value: 105 },
    ]);
    expect(getMetricDailyTotals(profileId, "nutrition_kcal")).toEqual([
      { date: DATE, value: 1150 },
    ]);
  });

  it("replaying the same rolling window is idempotent (unchanged, no doubling)", async () => {
    const res = await post();
    expect(res.status).toBe(200);

    // The exporter re-sends the rolling 48h window; the keyed upserts write nothing.
    const split = latestSplit();
    expect(split.ok).toBe(1);
    expect(split.inserted).toBe(0);
    expect(split.updated).toBe(0);
    expect(split.unchanged).toBe(8);

    // No duplicate rows, and the daily total is unchanged (not doubled to 160).
    expect(samplesFor("protein_g")).toEqual([
      { date: DATE, value: 30 },
      { date: DATE, value: 50 },
    ]);
    expect(getMetricDailyTotals(profileId, "protein_g")).toEqual([
      { date: DATE, value: 80 },
    ]);
  });
});
