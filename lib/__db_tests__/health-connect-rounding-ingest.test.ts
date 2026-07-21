// DB INTEGRATION TIER — Health Connect boundary rounding, end-to-end (issue #1109).
//
// A phone exporter delivers full-precision canonical doubles: a distance of
// 32.397218025887694 km, an energy of 470.60464280472473 kcal, a weight of
// 70.438218025887694 kg. Stored verbatim they leak 17 digits into any surface that
// trusts the column (the morning digest, CSV export, the reprocess-diff UI). The fix
// rounds at the shared ingest boundary (boundedOrNull → roundForMetric), so this tier
// drives a synthetic real-shape batch through the REAL ingest write path — token auth
// → parse → upsert — and pins two facts:
//   • stored distance_km / weight_kg / active_kcal carry bounded precision,
//   • replaying the SAME rolling window stays idempotent (unchanged, no re-write) —
//     rounding is deterministic, so the SELECT-before-compare pre-image still matches.
//
// Runs via `npm run test:db`; the `db` singleton points at a per-file temp DB (setup.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/integrations/health-connect/ingest/route";
import { generateHealthConnectToken } from "@/lib/integrations/connections";
import { setTimezone } from "@/lib/settings";

let profileId: number;
let token: string;

const TZ = "UTC";
const DATE = "2026-05-10";

// Full-precision canonical floats, the exact class the issue cites. Distance is sent
// as meters (parser divides by 1000); weight as kilograms.
const PAYLOAD = {
  timestamp: `${DATE}T20:00:00Z`,
  app_version: "test",
  weight: [{ time: `${DATE}T07:00:00Z`, kilograms: 70.438218025887694 }],
  distance: [
    {
      start_time: `${DATE}T06:00:00Z`,
      end_time: `${DATE}T07:00:00Z`,
      meters: 32397.218025887694, // → 32.397218025887694 km raw
    },
  ],
  active_calories: [
    {
      start_time: `${DATE}T06:00:00Z`,
      end_time: `${DATE}T07:00:00Z`,
      calories: 470.60464280472473,
    },
  ],
  exercise: [
    {
      start_time: `${DATE}T06:00:00Z`,
      end_time: `${DATE}T07:00:00Z`,
      type: "running",
      distance_meters: 27838.81802588772, // → 27.83881802588772 km raw
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

function sampleValue(metric: string): number {
  const row = db
    .prepare(
      `SELECT value FROM metric_samples
        WHERE profile_id = ? AND metric = ? AND source = 'health-connect'
        ORDER BY start_time LIMIT 1`
    )
    .get(profileId, metric) as { value: number } | undefined;
  return row!.value;
}

function activityDistance(): number {
  const row = db
    .prepare(
      `SELECT distance_km FROM activities
        WHERE profile_id = ? AND source = 'health-connect'
        ORDER BY id LIMIT 1`
    )
    .get(profileId) as { distance_km: number } | undefined;
  return row!.distance_km;
}

function weight(): number {
  const row = db
    .prepare(
      `SELECT weight_kg FROM body_metrics
        WHERE profile_id = ? AND source = 'health-connect'
        ORDER BY id LIMIT 1`
    )
    .get(profileId) as { weight_kg: number } | undefined;
  return row!.weight_kg;
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('HC-ROUNDING')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);
  token = generateHealthConnectToken(profileId, "never");
});

describe("Health Connect boundary rounding — end to end (#1109)", () => {
  it("stores canonical floats at bounded precision (distance/weight 2dp, energy 1dp)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // distance_km sample → 2dp, activity distance_km → 2dp, weight_kg → 2dp, kcal → 1dp.
    expect(sampleValue("distance_km")).toBe(32.4);
    expect(activityDistance()).toBe(27.84);
    expect(weight()).toBe(70.44);
    expect(sampleValue("active_kcal")).toBe(470.6);

    // None of the stored numbers carries a long decimal.
    for (const v of [
      sampleValue("distance_km"),
      activityDistance(),
      weight(),
      sampleValue("active_kcal"),
    ]) {
      expect(String(v)).not.toMatch(/\d+\.\d{3,}/);
    }
  });

  it("replaying the same rolling window is idempotent (unchanged, no re-write)", async () => {
    const res = await post();
    expect(res.status).toBe(200);

    // Rounding is deterministic, so the pre-image compare still sees equality: the
    // resent window writes nothing.
    const split = latestSplit();
    expect(split.ok).toBe(1);
    expect(split.inserted).toBe(0);
    expect(split.updated).toBe(0);
    expect((split.unchanged ?? 0) > 0).toBe(true);

    // Values are unchanged (not re-rounded to a different quantum).
    expect(sampleValue("distance_km")).toBe(32.4);
    expect(activityDistance()).toBe(27.84);
    expect(weight()).toBe(70.44);
  });
});
