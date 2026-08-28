// DB INTEGRATION TIER — the prod loss of #3901, as a sequence rather than a push.
//
// WHAT WAS LOST. Two days of steps, distance and kcal were deleted on prod during the
// 2026-08-21…28 Honolulu round trip and could not be re-sent: the exporter's ~48 h
// window had moved past them. The owner restored the five rows by hand from the nightly
// backups on 2026-08-28T03:40Z.
//
// THE MECHANISM, AND WHY ONE PUSH CANNOT SHOW IT. A day bucket's window is cut by the
// DEVICE — `started_at` is the device-local midnight — while the app filed the row under
// the PROFILE's zone at push time, and those disagree for hours around every travel
// switch because the phone re-anchors on landing and the profile flips when the person
// taps the travel banner. A re-anchored bucket therefore landed on its NEIGHBOUR's date,
// satisfied cover-the-day against the neighbour's completed row and superseded it — and
// then `resendDay`'s carve-out let it re-derive its own date on the next push and walk
// off the day it had just emptied. Every step is legal within its own push; the loss
// only exists across three of them. THAT IS WHY THE INVARIANT BELOW IS ASSERTED OVER THE
// WHOLE SEQUENCE and not per push: the per-push assertion is the one that already
// passed while prod was losing days.
//
// SYNTHETIC ONLY: a fictional traveller, invented step counts, no PHI.

import { describe, expect, it, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { getTimezone, setTimezone } from "@/lib/settings";
import { pushMetricSamples } from "./hc-metric-sample-push";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

function freshProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function stepRows(profileId: number): { date: string; value: number }[] {
  return db
    .prepare(
      `SELECT date, value FROM metric_samples
        WHERE profile_id = ? AND metric = 'steps'
        ORDER BY date, started_at`
    )
    .all(profileId) as { date: string; value: number }[];
}

/** One exporter push of a single `daily` steps bucket, through the real ingest. */
function pushSteps(
  profileId: number,
  stamp: string,
  start: string,
  end: string,
  count: number
): void {
  ingestHealthConnectPayload(
    profileId,
    parseHealthConnectPayload(
      {
        timestamp: stamp,
        steps: [
          {
            start_time: start,
            end_time: end,
            count,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      getTimezone(profileId)
    )
  );
}

describe("the prod sequence of #3901, through the profile's late flip", () => {
  it("never lets a date lose its last row, and lands one bucket per day", () => {
    const p = freshProfile("HC Round Trip");
    setTimezone(p, "Pacific/Honolulu");

    // A DATE THAT HAS EVER HELD A ROW MUST STILL HOLD ONE. Checked after EVERY push,
    // which is the only way to see a day that is emptied by one push and abandoned by
    // the next — the store is correct at the start and correct at the end, and the hole
    // opens in between.
    const everHeld = new Set<string>();
    const step = (
      stamp: string,
      start: string,
      end: string,
      count: number
    ): void => {
      pushSteps(p, stamp, start, end, count);
      const held = new Set(stepRows(p).map((r) => r.date));
      for (const date of everHeld) {
        expect(
          held.has(date),
          `${date} lost its last row after the push stamped ${stamp}`
        ).toBe(true);
      }
      for (const date of held) everHeld.add(date);
    };

    // 08-25, on Honolulu time: the day fills, then completes at HST midnight.
    step("2026-08-25T20:00:05Z", "2026-08-25T10:00:00Z", "2026-08-25T20:00:00Z", 5200);
    step("2026-08-26T09:58:05Z", "2026-08-25T10:00:00Z", "2026-08-26T09:58:00Z", 8672);

    // THE FIRST SKEW WINDOW. The traveller lands in Los Angeles and the phone re-anchors
    // to UTC-7 immediately; the profile is still Pacific/Honolulu because the banner has
    // not been tapped. Under the profile's zone 2026-08-26T07:00Z reads 2026-08-25
    // 21:00 — so this bucket used to be filed on 08-25, where it overlapped and
    // superseded the completed 8672 row above.
    step("2026-08-26T21:00:05Z", "2026-08-26T07:00:00Z", "2026-08-26T21:00:00Z", 4100);
    setTimezone(p, "America/Los_Angeles");
    step("2026-08-27T06:58:05Z", "2026-08-26T07:00:00Z", "2026-08-27T06:58:00Z", 6608);

    // THE SECOND SKEW WINDOW, and the exact prod push: the NY-anchored bucket
    // (`start_time 2026-08-27T04:00:00Z`) arrived at 21:51:56Z while the profile still
    // held America/Los_Angeles, which files it under LA-local 2026-08-26.
    step("2026-08-27T21:51:56Z", "2026-08-27T04:00:00Z", "2026-08-27T21:51:56Z", 3300);
    setTimezone(p, "America/New_York");
    // And the re-send after the flip, which is where the justifying row used to
    // re-derive its date and abandon the day it had emptied.
    step("2026-08-28T02:00:05Z", "2026-08-27T04:00:00Z", "2026-08-28T02:00:00Z", 7150);

    expect(stepRows(p)).toEqual([
      { date: "2026-08-25", value: 8672 },
      { date: "2026-08-26", value: 6608 },
      { date: "2026-08-27", value: 7150 },
    ]);
  });
});

describe("a bucket whose FIRST push is narrower than the granularity gate", () => {
  it("is repaired onto its anchor's day rather than frozen on the neighbour's", () => {
    // THE HOLE THE CARVE-OUT'S REMOVAL RE-OPENS, and the narrow exception that closes it.
    // A window of 30 minutes states no anchor the rule will read (`SUB_DAILY_WINDOW_MAX_MIN`
    // is 60), so the parser files that first push under the PROFILE's zone — which inside a
    // skew window is the neighbour's day. The exporter pushes every ~17 minutes, so every
    // device midnight crossed while the banner is untapped produces one.
    //
    // MUTATION: delete the `anchorRefusesDay` branch in `resendDay` and this reds — the
    // 08-27 bucket stays frozen on 08-26 beside the real 6608 and 2026-08-27 holds NO ROW.
    const p = freshProfile("HC Sub-Hour First Push");
    setTimezone(p, "America/Los_Angeles");
    // The LA 08-26 day, last sent before the device re-anchored.
    pushSteps(p, "2026-08-27T03:00:05Z", "2026-08-26T07:00:00Z", "2026-08-27T03:00:00Z", 6608);
    // NY midnight is 2026-08-27T04:00Z, which is 08-26 21:00 in Los Angeles: the first
    // push of the new anchoring lands 30 minutes later, under the profile's 08-26.
    pushSteps(p, "2026-08-27T04:30:05Z", "2026-08-27T04:00:00Z", "2026-08-27T04:30:00Z", 120);
    expect(stepRows(p)).toEqual([
      { date: "2026-08-26", value: 6608 },
      { date: "2026-08-26", value: 120 },
    ]);
    // Grown past the hour, so the anchor is now readable — and it says 08-27.
    pushSteps(p, "2026-08-27T21:51:56Z", "2026-08-27T04:00:00Z", "2026-08-27T21:51:56Z", 3300);
    setTimezone(p, "America/New_York");
    pushSteps(p, "2026-08-28T02:00:05Z", "2026-08-27T04:00:00Z", "2026-08-28T02:00:00Z", 7150);
    expect(stepRows(p)).toEqual([
      { date: "2026-08-26", value: 6608 },
      { date: "2026-08-27", value: 7150 },
    ]);
  });
});

describe("THE ANCHOR GUARD, behaviourally (#3901)", () => {
  // DEFENCE IN DEPTH, AND IT SHOULD NEVER FIRE. With the derivation above, a day
  // bucket's `date` is a function of its `started_at`, so a bucket cannot be filed
  // anywhere but the day its anchor names. The guard exists for the NEXT attribution
  // bug: an incoming bucket whose filed day contradicts its own anchor writes, and
  // deletes nothing — a visible double count instead of a hole. So the mislabeled row
  // has to be built by hand here; the parser can no longer produce one.
  let p: number;
  const completed = {
    metric: "steps",
    date: "2026-08-26",
    started_at: "2026-08-26T07:00:00Z",
    ended_at: "2026-08-27T07:00:00Z",
    value: 6608,
    origin: ORIGIN,
  };

  beforeEach(() => {
    p = freshProfile("HC Guard");
    pushMetricSamples(p, [completed], HC, undefined, {
      pushedAt: "2026-08-27T07:00:05Z",
    });
  });

  it("refuses the victim when the incoming bucket contradicts its own anchor", () => {
    // MUTATION: delete the `anchorContradictsDate` branch in `planSupersede` and this
    // reds — `removed` goes to 1 and the completed 6608 day is gone, which is the prod
    // loss reproduced through the real supersede.
    const out = pushMetricSamples(
      p,
      [
        {
          metric: "steps",
          // Filed on the neighbour's day; its own anchor (04:00Z, UTC-4) says 08-27.
          date: "2026-08-26",
          started_at: "2026-08-27T04:00:00Z",
          ended_at: "2026-08-27T21:51:56Z",
          value: 3300,
          origin: ORIGIN,
        },
      ],
      HC,
      undefined,
      { pushedAt: "2026-08-27T21:51:56Z" }
    );
    expect(out.superseded).toBe(0);
    // Written, not withheld — and counted, so the day reading high is said out loud.
    expect(out.overlapsLeft).toBe(1);
    expect(stepRows(p).map((r) => r.value).sort((a, b) => a - b)).toEqual([
      3300, 6608,
    ]);
  });

  it("still supersedes the SAME-DAY re-anchor pair, which is #3424's own shape", () => {
    // THE CONVERSE, so the guard cannot pass by refusing everything. A same-day re-cut —
    // the LA bucket at 07:00Z and the NY bucket at 04:00Z, BOTH naming 2026-08-26 — is a
    // different natural key, overlaps, and is filed under the day its anchor names, so
    // it collapses as #3424 designed. That is the shape the prod incident had, and it is
    // untouched by the derivation.
    const out = pushMetricSamples(
      p,
      [
        {
          metric: "steps",
          date: "2026-08-26",
          started_at: "2026-08-26T04:00:00Z",
          ended_at: "2026-08-26T20:00:00Z",
          value: 6700,
          origin: ORIGIN,
        },
      ],
      HC,
      undefined,
      { pushedAt: "2026-08-27T07:30:05Z" }
    );
    expect(out.superseded).toBe(1);
    expect(stepRows(p)).toEqual([{ date: "2026-08-26", value: 6700 }]);
    expect(out.overlapsLeft).toBe(0);
  });
});
