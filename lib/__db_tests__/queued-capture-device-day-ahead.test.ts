// DB INTEGRATION TIER — a queued capture whose date is one day AHEAD of the profile's
// today (#4425 review finding).
//
// WHY THIS DATE IS REACHABLE, which is the whole point. It used to be reachable through
// the QUEUE: the dose capture stamped its day off the browser's zone while every core
// resolves the day through `today(profileId)`, the profile's zone, so a device east of
// that zone captured tomorrow. #4559 closed that route at the capture — the day is read
// in the profile's zone now, and the browser-zone helper is gone from the tree.
//
// The date is still reachable, because it never depended on that route: a queued intent
// is a wire value a device holds and can be replayed on any later day, and the dated
// forms post a day the person typed. The bound below is what makes either safe, so it
// stays exactly where #4425 put it.
//
// #4425 gave three replayed cores the shared not-future invariant, and only two of the
// three could report it. `upsertMoodLog` and `logBristolStool` answer the replay's own
// `if (!ok)` dead-letter. `insertVitals` did not: it IGNORES `recordReading`'s outcome
// in both of its loops, so the refusal had no channel — the sitting reported success
// and wrote nothing. The queue's contract (lib/offline/queue.ts) is that a refusal
// "dead-letters with its reason instead of vanishing"; that one vanished, and the fix
// is to judge the day at `insertVitals`' own door where the channel already exists.

import { afterEach, describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { TIER_FROZEN_INSTANT } from "./frozen-clock";
import { shiftDateStr } from "@/lib/date";
import { applyIntent, insertVitals } from "@/lib/offline/writes";
import { buildIntent } from "@/lib/offline/queue";
import type { FlowKind, IntentPayload } from "@/lib/offline/queue";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function readingCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

const mood = (valence: number) => ({
  valence,
  energy: null,
  anxiety: null,
  factors: [],
  note: null,
});

const VITALS_PAYLOAD = {
  systolic: "118",
  diastolic: "76",
  glucose: null,
  glucoseUnit: null,
  spo2: null,
  temperature: null,
  tempUnit: null,
  sleepHours: null,
  hrv: null,
  respiratoryRate: null,
  gripStrength: null,
  chairStand: null,
  balance: null,
  peakFlow: null,
};

describe("a capture dated ahead of the profile's day (#4425 review)", () => {
  // ALL THREE REPLAYED CORES THIS ISSUE GATED, in one table, because the failure is
  // per-core and the contract is shared: whatever a core refuses, the replay must
  // REPORT. `rejected` is the report — the reconnect channel says so and the entry is
  // kept for the person to re-enter. `done` over an empty table is the silent loss.
  // The row counted is the one that flow writes.
  it.each<[FlowKind, IntentPayload, (p: number) => number]>([
    [
      "mood",
      mood(4),
      (p) =>
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM mood_logs WHERE profile_id = ?")
            .get(p) as { n: number }
        ).n,
    ],
    [
      "stool",
      { type: 4, at: null },
      (p) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ?"
            )
            .get(p) as { n: number }
        ).n,
    ],
    ["vitals", VITALS_PAYLOAD, readingCount],
  ])(
    "dead-letters a queued %s capture instead of losing it",
    (flow, payload, count) => {
      const p = newProfile(`device-ahead-${flow}`);
      const ahead = shiftDateStr(today(p), 1);

      const result = applyIntent(p, buildIntent(flow, ahead, payload, p));

      expect(result.status).toBe("rejected");
      expect(count(p)).toBe(0);
    }
  );

  // The sitting is the one whose refusal had no channel, so it is also asserted at the
  // core's own door: `wrote: true` over an empty table is the exact shape the loops'
  // discarded outcomes produced.
  it("refuses a sitting at the door rather than reporting a success it did not write", () => {
    const p = newProfile("device-ahead-direct");
    const outcome = insertVitals(
      p,
      shiftDateStr(today(p), 1),
      { systolic: "120", diastolic: "80" },
      "page"
    );

    expect(outcome).toEqual({ wrote: false });
    expect(readingCount(p)).toBe(0);
  });

  // The converse, so the guard cannot pass by refusing everything: the same sitting on
  // the profile's own day still lands.
  it("still writes the same sitting on the profile's own day", () => {
    const p = newProfile("device-same-day");
    const outcome = insertVitals(
      p,
      today(p),
      { systolic: "120", diastolic: "80" },
      "page"
    );
    expect(outcome).toMatchObject({ wrote: true });
    expect(readingCount(p)).toBeGreaterThan(0);
  });
});

// THE ANCHOR IS THE CAPTURE, AND REPLAY MUST NOT MOVE IT (#4559). Reading the day in
// the profile's zone is only faithful if it is read AT THE TAP; a replay that re-derived
// it would land a Tuesday-night check-in on Wednesday for no reason but a slow
// reconnect, and the queue's own contract is that a late replay lands on the day the
// user logged it however long the queue sat.
//
// This is what a replay-side redesign would break, so it is pinned here rather than
// left as prose: the queue sits across the profile's midnight, and the day does not
// move. The double replay is the second half of the same property — `UNIQUE(profile_id,
// date)` upserts and the practice flow's day-idempotence all key on the replayed date,
// and an idempotence that holds only on the first replay is not idempotence.
describe("a capture replayed after the profile's day has moved (#4559)", () => {
  const CAPTURE = new Date("2026-08-29T23:50:00.000Z");
  // Twenty minutes later, and a different day in UTC — the profile's own midnight, not
  // the host's.
  const REPLAY = new Date("2026-08-30T00:10:00.000Z");

  afterEach(() => vi.setSystemTime(TIER_FROZEN_INSTANT));

  it("lands on the captured day, and lands there again on a second flush", () => {
    const p = newProfile("capture-anchor");
    setTimezone(p, "UTC");

    vi.setSystemTime(CAPTURE);
    const captureDay = today(p);
    const intent = buildIntent("mood", captureDay, mood(4), p, CAPTURE);

    vi.setSystemTime(REPLAY);
    // The fixture reaches the state the assertion is about: the profile's today has
    // genuinely moved past the captured day before either replay runs.
    expect(today(p)).not.toBe(captureDay);

    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(applyIntent(p, intent)).toEqual({ status: "duplicate" });

    expect(
      db
        .prepare("SELECT date FROM mood_logs WHERE profile_id = ?")
        .all(p)
        .map((row) => (row as { date: string }).date)
    ).toEqual([captureDay]);
  });

  // BOTH SPELLINGS DRAIN THROUGH ONE QUEUE. The fix is at the CAPTURE, so a device
  // that has not reloaded still holds intents a pre-fix build stamped in the BROWSER's
  // zone — a day ahead of the profile's, whenever the device sits east of it. Those
  // replay beside intents the fixed capture stamped, and each entry gets its own
  // transaction, so the stale day has to dead-letter ITSELF and take nothing with it.
  // The pre-fix leg is the deliberate failure here: it is the only one asserted to be
  // refused, and the row below is what proves the refusal cost the other one nothing.
  it("dead-letters a pre-fix capture without costing the fixed one beside it", () => {
    const p = newProfile("mixed-queue");
    const day = today(p);
    const preFix = buildIntent("mood", shiftDateStr(day, 1), mood(2), p);
    const fixed = buildIntent("mood", day, mood(5), p);

    expect(applyIntent(p, preFix).status).toBe("rejected");
    expect(applyIntent(p, fixed)).toEqual({ status: "done" });

    expect(
      db
        .prepare("SELECT date, valence FROM mood_logs WHERE profile_id = ?")
        .all(p)
    ).toEqual([{ date: day, valence: 5 }]);
  });
});
