// DB INTEGRATION TIER — a queued capture whose date is one day AHEAD of the profile's
// today (#4425 review finding).
//
// WHY THIS DATE IS REACHABLE, which is the whole point: the queue stamps
// `localDate()` (lib/offline/queue.ts) off the BROWSER clock — "the client's local date
// at capture time", in the queue's own words — while every write core resolves the day
// through `today(profileId)`, the PROFILE's zone. A device east of the profile's
// configured zone therefore captures tomorrow. That is a traveller, or simply a profile
// whose zone was set once and never followed the phone.
//
// #4425 gave three replayed cores the shared not-future invariant, and only two of the
// three could report it. `upsertMoodLog` and `logBristolStool` answer the replay's own
// `if (!ok)` dead-letter. `insertVitals` did not: it IGNORES `recordReading`'s outcome
// in both of its loops, so the refusal had no channel — the sitting reported success
// and wrote nothing. The queue's contract (lib/offline/queue.ts) is that a refusal
// "dead-letters with its reason instead of vanishing"; that one vanished, and the fix
// is to judge the day at `insertVitals`' own door where the channel already exists.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
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
      { valence: 4, energy: null, anxiety: null, factors: [], note: null },
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
  ])("dead-letters a queued %s capture instead of losing it", (flow, payload, count) => {
    const p = newProfile(`device-ahead-${flow}`);
    const ahead = shiftDateStr(today(p), 1);

    const result = applyIntent(p, buildIntent(flow, ahead, payload, p));

    expect(result.status).toBe("rejected");
    expect(count(p)).toBe(0);
  });

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
