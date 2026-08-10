// DB INTEGRATION TIER — the wrong-offset cross-source rescue (#2011) driven through
// the REAL Review loader. The pure suite (lib/__tests__/import-review.test.ts) owns
// the classification math; what this file proves is that a rescued pair actually
// REACHES Data → Review: loadActivityDupRows' SQL pre-filter buckets on (date, type)
// and keeps only buckets spanning more than one provenance, so a pair whose only
// oddity is a shifted clock has to survive that filter, the recorded-decision
// suppression, and the clustering before a person ever sees it.
//
// The fixture is the reported case: one walk imported from Health Connect and from
// Strava, whose copy carries a non-DST utc_offset and lands exactly one hour early.
// Before the fix the day held two walk rows and Review offered nothing.
//
// #2056 extends it past midnight. The SQL pre-filter's `(date, type)` grouping
// assumed the two copies of one session share a calendar day, which the same wrong
// offset makes false for a late-evening session: a 23:30 walk reported at 00:30 the
// next day landed in two different buckets and was never compared. The widened
// loader is what this file proves reaches Review — and, just as importantly, what it
// proves does NOT: genuinely distinct next-day sessions, and near-midnight pairs
// whose gap is not offset-shaped.

import { describe, it, expect, beforeAll } from "vitest";
import { db, hoistedStatement } from "@/lib/db";
import {
  getActivityDuplicates,
  getActivityDuplicateClusters,
} from "@/lib/queries";

let profileId: number;

const insAct = hoistedStatement(
  `INSERT INTO activities
     (profile_id, date, type, title, source, external_id,
      start_time, end_time, duration_min, distance_km)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('CLOCKOFF')").run()
      .lastInsertRowid
  );

  // (1) The reported pair: the same 25-minute walk, Strava's copy one hour early.
  //     MUST surface, at MEDIUM, naming the clock discrepancy.
  insAct.run(
    profileId,
    "2026-08-01",
    "cardio",
    "Walk",
    "health-connect",
    "health-connect:walk-1",
    "09:05",
    "09:30",
    25,
    2.1
  );
  insAct.run(
    profileId,
    "2026-08-01",
    "cardio",
    "Afternoon Walk",
    "strava",
    "strava:walk-1",
    "08:05",
    "08:30",
    25,
    2.11
  );

  // (2) Two genuinely distinct cross-source sessions an hour apart, starting at
  //     different minutes past the hour. MUST NOT surface — the whole-hour gate is
  //     the only thing standing between the rescue and real back-to-back workouts.
  insAct.run(
    profileId,
    "2026-08-02",
    "cardio",
    "Warm-up walk",
    "health-connect",
    "health-connect:walk-2",
    "08:00",
    "08:25",
    25,
    2.1
  );
  insAct.run(
    profileId,
    "2026-08-02",
    "cardio",
    "Second walk",
    "strava",
    "strava:walk-2",
    "09:12",
    "09:37",
    25,
    2.1
  );

  // (3) A whole hour apart but the distances genuinely disagree — two different
  //     rides, not one ride seen twice. MUST NOT surface.
  insAct.run(
    profileId,
    "2026-08-03",
    "cardio",
    "Commute out",
    "health-connect",
    "health-connect:ride-1",
    "07:00",
    "07:30",
    30,
    8
  );
  insAct.run(
    profileId,
    "2026-08-03",
    "cardio",
    "Long ride",
    "strava",
    "strava:ride-1",
    "08:00",
    "08:30",
    30,
    22
  );

  // (4) #2056's reported case: ONE 23:30 walk, Strava's copy an hour late and
  //     therefore filed under the NEXT day. MUST surface, at MEDIUM.
  insAct.run(
    profileId,
    "2026-08-10",
    "cardio",
    "Night walk",
    "health-connect",
    "health-connect:night-1",
    "23:30",
    "23:55",
    25,
    2.1
  );
  insAct.run(
    profileId,
    "2026-08-11",
    "cardio",
    "Evening Walk",
    "strava",
    "strava:night-1",
    "00:30",
    "00:55",
    25,
    2.11
  );

  // (5) Two genuinely distinct sessions on consecutive days — a late ride and a
  //     mid-morning one. Adjacent days, one type, two sources, matching numbers:
  //     everything the widening admits EXCEPT proximity to the midnight between
  //     them. MUST NOT surface.
  insAct.run(
    profileId,
    "2026-08-13",
    "cardio",
    "Night ride",
    "health-connect",
    "health-connect:ride-2",
    "23:40",
    "00:10",
    30,
    8
  );
  insAct.run(
    profileId,
    "2026-08-14",
    "cardio",
    "Morning ride",
    "strava",
    "strava:ride-2",
    "09:00",
    "09:30",
    30,
    8.05
  );

  // (6) Near midnight on BOTH sides, but 65 minutes apart — no UTC offset differs
  //     by that, so it is two sessions either side of midnight. MUST NOT surface;
  //     the offset SHAPE is the entire safety margin the widening leans on.
  insAct.run(
    profileId,
    "2026-08-16",
    "cardio",
    "Late walk",
    "health-connect",
    "health-connect:night-2",
    "23:15",
    "23:40",
    25,
    2.1
  );
  insAct.run(
    profileId,
    "2026-08-17",
    "cardio",
    "Small hours walk",
    "strava",
    "strava:night-2",
    "00:20",
    "00:45",
    25,
    2.1
  );
});

describe("wrong-offset cross-source rescue through the Review loader (#2011)", () => {
  it("surfaces the offset copy as a MEDIUM pair naming the clock difference", () => {
    const pairs = getActivityDuplicates(profileId).filter(
      (p) => p.a.date === "2026-08-01"
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("medium");
    expect(pairs[0].reason).toBe(
      "Same day, similar duration/distance — clocks differ by 1h"
    );
    expect([pairs[0].a.source, pairs[0].b.source].sort()).toEqual([
      "health-connect",
      "strava",
    ]);
  });

  it("renders it as one Review cluster carrying both copies", () => {
    const clusters = getActivityDuplicateClusters(profileId).filter(
      (c) => c.date === "2026-08-01"
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.start_time).sort()).toEqual([
      "08:05",
      "09:05",
    ]);
  });

  it("leaves genuinely distinct same-day sessions alone", () => {
    const dates = getActivityDuplicates(profileId).map((p) => p.a.date);
    expect(dates).not.toContain("2026-08-02");
    expect(dates).not.toContain("2026-08-03");
  });
});

describe("the offset that crosses midnight reaches Review (#2056)", () => {
  it("surfaces the split copies as ONE medium pair naming the crossing", () => {
    const pairs = getActivityDuplicates(profileId).filter((p) =>
      ["2026-08-10", "2026-08-11"].includes(p.a.date)
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].confidence).toBe("medium");
    expect(pairs[0].reason).toBe(
      "Across midnight, similar duration/distance — clocks differ by 1h"
    );
    expect([pairs[0].a.external_id, pairs[0].b.external_id].sort()).toEqual([
      "health-connect:night-1",
      "strava:night-1",
    ]);
  });

  it("renders it as one cluster, named by the day the session started", () => {
    const clusters = getActivityDuplicateClusters(profileId).filter((c) =>
      c.members.some((m) => m.external_id === "strava:night-1")
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].date).toBe("2026-08-10");
    expect(clusters[0].members.map((m) => m.date).sort()).toEqual([
      "2026-08-10",
      "2026-08-11",
    ]);
  });

  it("leaves genuinely distinct next-day sessions alone", () => {
    const dates = getActivityDuplicates(profileId).map((p) => p.a.date);
    // (5) far from midnight on the morning side; (6) near it but not offset-shaped.
    expect(dates).not.toContain("2026-08-13");
    expect(dates).not.toContain("2026-08-14");
    expect(dates).not.toContain("2026-08-16");
    expect(dates).not.toContain("2026-08-17");
  });

  // The widening is a CANDIDATE gate. Pinning the exact pair count is what keeps it
  // a gate: six cross-source days sit in this profile and exactly two of them are a
  // duplicate, so a loader that started loading the whole history — or a classifier
  // that started forgiving the shape — fails here rather than in production.
  it("adds exactly the one pair, not a candidate explosion", () => {
    expect(getActivityDuplicates(profileId)).toHaveLength(2);
  });
});
