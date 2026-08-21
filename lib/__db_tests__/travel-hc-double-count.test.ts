// REPRO — investigation evidence for the travel/tz review, deliberately named
// `.repro.ts` so the `*.test.ts` globs never collect it. To run it, rename to
// `.test.ts` and use `npx vitest run --config vitest.db.config.ts <file>`.
// It FAILS on main: the switch day reads 6500 steps for 3500 walked.
//
// Health Connect daily-window records double count on the travel switch day
// (#3263 follow-up).
//
// The exporter's recommended setting for steps is `daily`: one record per
// device-local day, window = local midnight → now. When the device (and, via the
// travel banner, the profile) moves zones, the exporter's "today" window is
// re-anchored to the NEW zone's midnight — a NEW started_at. The old-zone daily
// record stays in metric_samples (its key never re-appears in a push, so nothing
// replaces it), the new record's window overlaps it, and both carry the same
// profile-local `date` at ingest → getMetricDailyTotals SUMs them.

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

describe("HC daily steps across a westward travel switch", () => {
  it("counts the pre-switch steps twice on the switch day", () => {
    freeze(SWITCH_INSTANT);

    // Push 1, before the switch (device on Tokyo time). The exporter's `daily`
    // steps record for Tokyo 2026-05-02: window = Tokyo midnight → now,
    // 3000 steps walked that Tokyo morning.
    const push1 = parseHealthConnectPayload(
      {
        steps: [
          {
            start_time: "2026-05-01T15:00:00Z", // Tokyo 2026-05-02 00:00
            end_time: "2026-05-01T23:00:00Z", // Tokyo 2026-05-02 08:00
            count: 3000,
            data_origin: "com.fitbit.FitbitMobile",
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
        steps: [
          // The rolling ~48h window re-sends the pre-switch record too. Same
          // started_at → same natural key → its `date` is recomputed under the
          // NEW profile zone (ON CONFLICT SET date = excluded.date).
          {
            start_time: "2026-05-01T15:00:00Z",
            end_time: "2026-05-01T23:00:00Z",
            count: 3000,
            data_origin: "com.fitbit.FitbitMobile",
          },
          {
            start_time: "2026-05-01T10:00:00Z", // Honolulu 2026-05-01 00:00
            end_time: "2026-05-02T01:00:00Z",
            count: 3500,
            data_origin: "com.fitbit.FitbitMobile",
          },
        ],
      },
      getTimezone(profileId)
    );
    ingestHealthConnectPayload(profileId, push2);

    const rows = db
      .prepare(
        "SELECT date, started_at, value FROM metric_samples WHERE profile_id = ? AND metric = 'steps' ORDER BY started_at"
      )
      .all(profileId) as { date: string; started_at: string; value: number }[];
    // Investigation aid: show what actually landed.
    console.log("metric_samples rows:", rows);

    const totals = getMetricDailyTotals(profileId, "steps");
    console.log("daily totals:", totals);

    // The person walked 3500 steps in total. The switch day should read 3500.
    const switchDay = totals.find((t) => t.date === "2026-05-01");
    expect(switchDay?.value).toBe(3500);
  });
});
