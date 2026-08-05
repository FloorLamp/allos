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

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  getActivityDuplicates,
  getActivityDuplicateClusters,
} from "@/lib/queries";

let profileId: number;

const insAct = db.prepare(
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
