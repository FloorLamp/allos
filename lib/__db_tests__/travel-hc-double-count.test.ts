// DB INTEGRATION TIER — #3424's acceptance criterion 1, and the whole bug in one test.
//
// This file began as the runnable repro pushed with the travel/tz review
// (claude/travel-tz-adjustment-review-7qj8t4, `travel-hc-double-count.repro.ts`). It
// FAILED on main reading 6500 steps for 3500 walked, and was promoted to a real test
// here so the measured scenario stays guarded.
//
// ITS SETUP IS NO LONGER VERBATIM, and the change is named rather than quiet: #3901
// re-pointed BOTH zones and BOTH `start_time`s. The original flew Asia/Tokyo ->
// Pacific/Honolulu, which crosses the date line, so under the anchor-implied day the two
// anchorings name 05-02 and 05-01 and are two days' readings rather than one day read
// twice — the pair simply stops being the shape this file is about. America/New_York ->
// Pacific/Honolulu (04:00Z and 10:00Z, both naming 2026-05-01) is the same westward
// switch without the crossing, and is the shape #3424's prod incident actually had.
// Every assertion, every count and the three-push structure are unchanged; the stored
// rows now sort old-anchoring-first, because a real westward re-anchor starts LATER in
// UTC — which this module's own rule states and which Tokyo -> Honolulu contradicted.
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
import { getMetricDailyTotals } from "@/lib/queries";
import {
  getTimezone,
  setTimezone,
  switchProfileTimezone,
} from "@/lib/settings";

// THE PAIR MUST NAME ONE DAY, AND SINCE #3901 THAT IS A CONSTRAINT ON THE ZONES.
// A day bucket is now filed under the day its OWN anchor names, so two anchorings
// collapse into one row only when both name the same calendar day. This file used to
// fly Tokyo -> Honolulu, which crosses the date line: those two anchorings name
// 05-02 and 05-01, so they are two days' readings and cover-the-day never matched
// them. New York -> Honolulu is the same westward switch WITHOUT the date-line
// crossing (04:00Z and 10:00Z both name 2026-05-01), which is the shape #3424's prod
// incident actually had.
const NEW_YORK = "America/New_York";
const HONOLULU = "Pacific/Honolulu";

// 2026-05-01T23:00:00Z = New York 2026-05-01 19:00 (the traveller's evening) and
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
  setTimezone(profileId, NEW_YORK);
});

// THE ORIGIN IS UNDER `metadata`, and that is not cosmetic. `dataOrigin` reads only
// `metadata.data_origin` (lib/integrations/health-connect.ts), so a fixture that puts it
// at the record's top level parses every sample to `origin = null` — the widest possible
// supersede group, and not the one this scenario claims to be about. The original repro
// had it at the top level and an adversarial review caught it.
describe("HC daily steps across a westward travel switch", () => {
  it("counts the switch day once, not twice — by the push after the switch", () => {
    freeze(SWITCH_INSTANT);

    // Push 1, before the switch (device on New York time). The exporter's `daily`
    // steps record for New York 2026-05-01: window = NY midnight → now,
    // 3000 steps walked that New York day.
    const push1 = parseHealthConnectPayload(
      {
        // Every real exporter push states this, and the supersede requires it: freshness
        // is what the PAYLOAD says, never what the rows' own windows imply.
        timestamp: "2026-05-01T23:00:05Z",
        steps: [
          {
            start_time: "2026-05-01T04:00:00Z", // New York 2026-05-01 00:00
            end_time: "2026-05-01T23:00:00Z", // New York 2026-05-01 19:00
            count: 3000,
            metadata: { data_origin: "com.fitbit.FitbitMobile" },
          },
        ],
      },
      getTimezone(profileId)
    );
    ingestHealthConnectPayload(profileId, push1);

    // The one-tap travel switch — the accept action's whole path, which DELETES NOTHING.
    // #3551 removed the trailing-window sweep this used to call; it only ever touched
    // `body_metrics`, never `metric_samples`, so what this test measures is unchanged.
    switchProfileTimezone(profileId, HONOLULU, NEW_YORK);
    expect(today(profileId)).toBe("2026-05-01");

    // Push 2, after the switch (device now on Honolulu time). Health Connect
    // re-buckets "today" from Honolulu midnight: window = 2026-05-01T10:00Z → now.
    // The Honolulu day re-contains the NY day from 10:00Z on and reports 3500 for it;
    // 04:00Z–10:00Z is the leading sliver the rule documents as its accepted trade.
    freeze("2026-05-02T01:00:00Z"); // Honolulu 2026-05-01 15:00
    const push2 = parseHealthConnectPayload(
      {
        timestamp: "2026-05-02T01:00:05Z",
        steps: [
          // The rolling ~48h window re-sends the pre-switch record too. Same
          // started_at → same natural key → and since #3901 the day it is filed
          // under is a function of that key, so the re-send cannot move it.
          {
            start_time: "2026-05-01T04:00:00Z",
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

    // THIS DIVERGES FROM #3424's ACCEPTANCE CRITERION 1 AS WRITTEN, deliberately, and
    // it is the one place in this branch where that is true. The AC says the switch day
    // reads 3500 after "the one-tap switch + next push". It does — but after the push
    // AFTER this one, not this one.
    //
    // WHY. This payload puts both anchorings in a SINGLE push, and nothing in a push can
    // tell them apart. The stamp is per-push, so both rows carry the same one. The ends
    // are a window quantity, and lib/metric-window-overlap.ts's header is a page on why
    // that comparison is invalid on exactly this pair — two earlier versions made it
    // anyway and stored 3000 for 3500 walked, then regressed an already-correct store.
    // Nothing else exists to decide with: measured over 306 captured payloads and 964
    // additive records, a record carries `start_time`, `end_time`, its value and
    // `metadata.data_origin`. One metadata key.
    //
    // Nor is the shape observed: not one of those 306 pushes carries two overlapping
    // same-(metric, origin) day buckets, though the corpus holds two distinct anchorings
    // (04:00Z and 00:00Z). The re-send-alongside claim comes from #3424's narrative.
    //
    // So the switch day reads HIGH for one push — visible in every total, and stated in
    // Review — and converges below. Reading high is repairable; the alternative on offer
    // was a reading that vanished. WHETHER THAT MEETS THE AC IS THE OWNER'S CALL, and
    // this comment exists so the question is not silently answered by a fixture.
    expect(rows.map((r) => r.value)).toEqual([3000, 3500]);
    const afterSwitchPush = getMetricDailyTotals(profileId, "steps").find(
      (t) => t.date === "2026-05-01"
    );
    expect(afterSwitchPush?.value).toBe(6500);

    // Push 3, the next ordinary push of the rolling window: one anchoring, a later
    // stamp, and the stale row goes.
    freeze("2026-05-02T05:00:00Z");
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(
        {
          timestamp: "2026-05-02T05:00:05Z",
          steps: [
            {
              start_time: "2026-05-01T10:00:00Z",
              end_time: "2026-05-02T05:00:00Z",
              count: 3500,
              metadata: { data_origin: "com.fitbit.FitbitMobile" },
            },
          ],
        },
        getTimezone(profileId)
      )
    );
    // The person walked 3500 steps in total. The switch day reads 3500.
    const totals = getMetricDailyTotals(profileId, "steps");
    const switchDay = totals.find((t) => t.date === "2026-05-01");
    expect(switchDay?.value).toBe(3500);
  });
});
