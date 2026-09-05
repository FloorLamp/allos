// DB INTEGRATION TIER — the profile's first and last stored HR instants (#5201).
//
// `hrInstantBounds` is private, and every open-ended HR reader resolves its missing
// end through it: an absent `from` becomes the profile's first day-with-data and an
// absent `to` becomes its last. So the two endpoints are observable one at a time,
// which is what makes them testable at all — a fixture that leaves BOTH ends open
// would still pass with one endpoint answering for both.
//
// #5201 replaced `SELECT MIN(ts), MAX(ts) … WHERE profile_id = ?` with two endpoint
// seeks. SQLite's min/max optimisation only applies to a query with exactly one
// aggregate, so asking for both in one statement gave up the index walk and visited
// every row the profile had. These cases pin the ANSWERS across that substitution.
//
// WHAT IS NOT PINNED HERE, said rather than implied: that the read visits only the two
// endpoint rows. `EXPLAIN QUERY PLAN` reports SEARCH for both forms, and better-sqlite3
// exposes no per-statement row counter, so there is no honest deterministic assertion
// for it — a wall-clock threshold on shared CI would measure the runner. The
// before/after measurement lives on the PR instead. The profile predicate on both
// subqueries is covered statically by lib/__tests__/profile-scoping.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { getHrDailySummaryInRange } from "@/lib/queries";

let profileId: number;
let neighbour: number;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function seedMinute(
  id: number,
  date: string,
  source = "health-connect",
  hhmm = "08:00"
): void {
  db.prepare(
    `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
     VALUES (?, ?, 70, 60, 90, 10, ?)`
  ).run(id, `${date}T${hhmm}:00Z`, source);
}

function days(rows: { date: string }[]): string[] {
  return rows.map((r) => r.date);
}

beforeEach(() => {
  db.exec("DELETE FROM hr_minutes");
  profileId = newProfile("HR-BOUNDS");
  neighbour = newProfile("HR-BOUNDS-NEIGHBOUR");
});

describe("the open end of an HR range resolves to the profile's own data", () => {
  it("has no bounds at all when the profile has no heart rate", () => {
    expect(
      getHrDailySummaryInRange(profileId, undefined, "2024-12-31")
    ).toEqual([]);
    expect(
      getHrDailySummaryInRange(profileId, "2024-01-01", undefined)
    ).toEqual([]);
  });

  it("resolves both ends to the same day when the profile has one minute", () => {
    seedMinute(profileId, "2024-04-15");
    expect(
      days(getHrDailySummaryInRange(profileId, undefined, "2024-12-31"))
    ).toEqual(["2024-04-15"]);
    expect(
      days(getHrDailySummaryInRange(profileId, "2024-01-01", undefined))
    ).toEqual(["2024-04-15"]);
  });

  // THE TWO ENDS ARE DIFFERENT QUESTIONS, and this is the case that says so. One
  // implementation answering both ends with the same seek — or seeking the wrong
  // direction — passes every fixture above and drops a real day here.
  it("opens from the FIRST day and closes at the LAST, not one of them twice", () => {
    seedMinute(profileId, "2024-03-10");
    seedMinute(profileId, "2024-05-01");
    seedMinute(profileId, "2024-06-20");

    // `from` absent → the window starts at the first day-with-data, so the two later
    // days are inside it and none is cut off the front.
    expect(
      days(getHrDailySummaryInRange(profileId, undefined, "2024-06-20"))
    ).toEqual(["2024-03-10", "2024-05-01", "2024-06-20"]);

    // `to` absent → the window ends at the last day-with-data, so nothing is cut off
    // the back.
    expect(
      days(getHrDailySummaryInRange(profileId, "2024-03-10", undefined))
    ).toEqual(["2024-03-10", "2024-05-01", "2024-06-20"]);
  });

  // The endpoints belong to the PROFILE, not to a source. A seek that narrowed to one
  // source would report this profile's history as starting in May and ending in May.
  it("takes each end from whichever source holds it", () => {
    seedMinute(profileId, "2024-03-10", "oura");
    seedMinute(profileId, "2024-05-01", "health-connect");
    seedMinute(profileId, "2024-06-20", "withings");

    expect(
      days(getHrDailySummaryInRange(profileId, undefined, "2024-06-20"))
    ).toEqual(["2024-03-10", "2024-05-01", "2024-06-20"]);
    expect(
      days(getHrDailySummaryInRange(profileId, "2024-03-10", undefined))
    ).toEqual(["2024-03-10", "2024-05-01", "2024-06-20"]);
  });

  // A neighbour whose history brackets this one on BOTH sides. The aggregate is
  // profile-scoped either way, so this cannot catch a dropped predicate on its own —
  // it is here because a bounds read that answered with another profile's instants
  // would make every open-ended window on a shared instance the widest profile's.
  it("is unmoved by a neighbour profile whose history is older and newer", () => {
    seedMinute(profileId, "2024-03-10");
    seedMinute(profileId, "2024-06-20");
    seedMinute(neighbour, "2020-01-01");
    seedMinute(neighbour, "2030-12-31");

    expect(
      days(getHrDailySummaryInRange(profileId, undefined, "2024-06-20"))
    ).toEqual(["2024-03-10", "2024-06-20"]);
    expect(
      days(getHrDailySummaryInRange(neighbour, "2020-01-01", undefined))
    ).toEqual(["2020-01-01", "2030-12-31"]);
  });
});
