// DB INTEGRATION TIER — a queued VITALS sitting whose capture date is one day AHEAD of
// the profile's today (#4425 review finding).
//
// WHY THIS DATE IS REACHABLE, which is the whole point: the queue stamps
// `localDate()` (lib/offline/queue.ts) off the BROWSER clock — "the client's local date
// at capture time", in the queue's own words — while every write core resolves the day
// through `today(profileId)`, the PROFILE's zone. A device east of the profile's
// configured zone therefore captures tomorrow. That is a traveller, or simply a profile
// whose zone was set once and never followed the phone.
//
// Before #4425 `insertVitals` asked only `isRealIsoDate`, so such a capture landed.
// #4425 gave `recordReading` the shared not-future invariant — and `insertVitals`
// IGNORES `recordReading`'s outcome in both of its loops, so the refusal had no channel:
// the sitting reported success and wrote nothing. The queue's own contract
// (lib/offline/queue.ts) is that a refusal "dead-letters with its reason instead of
// vanishing"; this vanished.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { applyIntent, insertVitals } from "@/lib/offline/writes";
import { buildIntent } from "@/lib/offline/queue";

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

describe("a sitting dated ahead of the profile's day (#4425 review)", () => {
  it("refuses at the door rather than reporting a success it did not write", () => {
    const p = newProfile("device-ahead-direct");
    const ahead = shiftDateStr(today(p), 1);

    const outcome = insertVitals(
      p,
      ahead,
      { systolic: "120", diastolic: "80" },
      "page"
    );

    // The answer and the table must agree. Reporting `wrote: true` while writing
    // nothing is the shape this test exists to forbid.
    expect(outcome).toEqual({ wrote: false });
    expect(readingCount(p)).toBe(0);
  });

  it("dead-letters the queued capture instead of losing it silently", () => {
    const p = newProfile("device-ahead-replay");
    const ahead = shiftDateStr(today(p), 1);

    const result = applyIntent(
      p,
      buildIntent(
        "vitals",
        ahead,
        {
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
        },
        p
      )
    );

    // Rejected is a REPORT: the reconnect channel says so and the entry is kept for
    // the person to re-enter. `done` with an empty table is the silent loss.
    expect(result.status).toBe("rejected");
    expect(readingCount(p)).toBe(0);
  });

  // The converse, so the guard cannot pass by refusing everything: the same sitting
  // on the profile's own day still lands.
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
