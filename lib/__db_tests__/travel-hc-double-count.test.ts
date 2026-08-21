// DB INTEGRATION TIER — #3424's acceptance criterion 1, and the whole bug in one test.
//
// This file began as the runnable repro pushed with the travel/tz review
// (claude/travel-tz-adjustment-review-7qj8t4, `travel-hc-double-count.repro.ts`). It
// FAILED on main reading 6500 steps for 3500 walked; it is kept verbatim in its setup
// and promoted to a real test here, so the exact scenario that was measured is the one
// that stays guarded.
//
// The mechanism, in one paragraph. The exporter's recommended `daily` setting for steps
// sends one record per DEVICE-LOCAL day: window = local midnight → now. When the device
// (and, via the travel banner, the profile) moves zones, "today" is re-anchored to the
// NEW zone's midnight — a NEW `started_at`, so a NEW natural key. The old-zone record
// stays in metric_samples because its key never re-appears in a push, the new record's
// window overlaps it, both carry the same profile-local `date` after ingest, and
// getMetricDailyTotals SUMs them.
//
// The rule that fixes it is lib/metric-window-overlap.ts; the wider guard suite is
// lib/__db_tests__/hc-overlap-supersede.test.ts. What this file adds is the SCENARIO —
// a real parse, a real one-tap switch, a real second push.
//
// SYNTHETIC ONLY: a fictional traveller, invented step counts, no PHI.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { sweepIngestWindowForTimezoneChange } from "@/lib/integrations/ingest-timezone-sweep";
import { getMetricDailyTotals } from "@/lib/queries";
import {
  getTimezone,
  setTimezone,
  switchProfileTimezone,
} from "@/lib/settings";

const TOKYO = "Asia/Tokyo";
const HONOLULU = "Pacific/Honolulu";

// 2026-05-01T23:00:00Z = Tokyo 2026-05-02 08:00 (the traveller's morning) and
// Honolulu 2026-05-01 13:00 (the same instant after the westward switch).
const SWITCH_INSTANT = "2026-05-01T23:00:00Z";

function freeze(instant: string): void {
  process.env.ALLOS_TEST_NOW = instant;
}

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("HC Traveller")
      .lastInsertRowid
  );
  setTimezone(profileId, TOKYO);
});

// THE ORIGIN IS UNDER `metadata`, and that is not cosmetic. `dataOrigin` reads only
// `metadata.data_origin` (lib/integrations/health-connect.ts), so a fixture that puts it
// at the record's top level parses every sample to `origin = null` — the widest possible
// supersede group, and not the one this scenario claims to be about. The original repro
// had it at the top level and an adversarial review caught it.
describe("HC daily steps across a westward travel switch", () => {
  it("counts the switch day once, not twice", () => {
    freeze(SWITCH_INSTANT);

    // Push 1, before the switch (device on Tokyo time). The exporter's `daily`
    // steps record for Tokyo 2026-05-02: window = Tokyo midnight → now,
    // 3000 steps walked that Tokyo morning.
    const push1 = parseHealthConnectPayload(
      {
        // Every real exporter push states this, and the supersede requires it: freshness
        // is what the PAYLOAD says, never what the rows' own windows imply.
        timestamp: "2026-05-01T23:00:05Z",
        steps: [
          {
            start_time: "2026-05-01T15:00:00Z", // Tokyo 2026-05-02 00:00
            end_time: "2026-05-01T23:00:00Z", // Tokyo 2026-05-02 08:00
            count: 3000,
            metadata: { data_origin: "com.fitbit.FitbitMobile" },
          },
        ],
      },
      getTimezone(profileId)
    );
    ingestHealthConnectPayload(profileId, push1);

    // The one-tap travel switch (accept action path: switch + sweep).
    switchProfileTimezone(profileId, HONOLULU, TOKYO);
    sweepIngestWindowForTimezoneChange(profileId);
    expect(today(profileId)).toBe("2026-05-01");

    // Push 2, after the switch (device now on Honolulu time). Health Connect
    // re-buckets "today" from Honolulu midnight: window = 2026-05-01T10:00Z → now.
    // The 3000 Tokyo-morning steps happened INSIDE that window (15:00Z–23:00Z),
    // so the new daily record carries them again, plus 500 walked after landing.
    freeze("2026-05-02T01:00:00Z"); // Honolulu 2026-05-01 15:00
    const push2 = parseHealthConnectPayload(
      {
        timestamp: "2026-05-02T01:00:05Z",
        steps: [
          // The rolling ~48h window re-sends the pre-switch record too. Same
          // started_at → same natural key → its `date` is recomputed under the
          // NEW profile zone (ON CONFLICT SET date = excluded.date).
          {
            start_time: "2026-05-01T15:00:00Z",
            end_time: "2026-05-01T23:00:00Z",
            count: 3000,
            metadata: { data_origin: "com.fitbit.FitbitMobile" },
          },
          {
            start_time: "2026-05-01T10:00:00Z", // Honolulu 2026-05-01 00:00
            end_time: "2026-05-02T01:00:00Z",
            count: 3500,
            metadata: { data_origin: "com.fitbit.FitbitMobile" },
          },
        ],
      },
      getTimezone(profileId)
    );
    ingestHealthConnectPayload(profileId, push2);

    const rows = db
      .prepare(
        "SELECT date, started_at, ended_at, value FROM metric_samples WHERE profile_id = ? AND metric = 'steps' ORDER BY started_at"
      )
      .all(profileId) as {
      date: string;
      started_at: string;
      ended_at: string;
      value: number;
    }[];

    // Only the Honolulu-anchored record survives — the Tokyo-anchored one it
    // re-contains was superseded rather than left to sum beside it.
    expect(rows).toEqual([
      {
        date: "2026-05-01",
        started_at: "2026-05-01T10:00:00Z",
        ended_at: "2026-05-02T01:00:00Z",
        value: 3500,
      },
    ]);

    // The person walked 3500 steps in total. The switch day reads 3500.
    const totals = getMetricDailyTotals(profileId, "steps");
    const switchDay = totals.find((t) => t.date === "2026-05-01");
    expect(switchDay?.value).toBe(3500);
  });
});
