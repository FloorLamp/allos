// DB TIER — the one-shot repair that ships with #3190's fix.
//
// `totalWorkouts` counted create-at-start husks, and the `milestones` table is BOTH
// the timeline entry and the once-only fired marker. So a husk did not merely send a
// wrong "10 workouts logged" — it wrote the key as fired, and the person's real 10th
// workout could then never be recognized. Wrong once, permanently. Excluding drafts
// from the count fixes the next crossing and leaves that one stranded, which is what
// migration 20260819-unstrand-husk-milestones releases.
//
// THE FIXTURE MUST BE ABLE TO SAY BOTH THINGS. A migration that deletes every
// workout milestone would satisfy "the stranded key is gone" on its own, so the
// earned key on a second profile is asserted to SURVIVE in the same run — and the
// goal milestone beside the stranded one survives too, since only the workout family
// is in scope.
//
// SYNTHETIC ONLY: fictional profiles, invented titles. No PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { up as unstrand } from "@/lib/migrations/versions/20260819-unstrand-husk-milestones";

const DAY = "2026-05-04";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addLogged(profileId: number, n: number): void {
  const insert = db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', ?, 30)`
  );
  for (let i = 0; i < n; i += 1) insert.run(profileId, DAY, `Session ${i + 1}`);
}

function addDraft(profileId: number): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, start_time)
     VALUES (?, ?, 'strength', 'Opened and abandoned', '09:00')`
  ).run(profileId, DAY);
}

function fire(profileId: number, key: string, kind: string, threshold: number) {
  db.prepare(
    `INSERT INTO milestones
       (profile_id, key, kind, threshold, title, detail, achieved_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(profileId, key, kind, threshold, `${key} title`, `${key} detail`, DAY);
}

const keysOf = (profileId: number) =>
  (
    db
      .prepare("SELECT key FROM milestones WHERE profile_id = ? ORDER BY key")
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);

describe("20260819-unstrand-husk-milestones", () => {
  let stranded: number;
  let earned: number;

  beforeAll(() => {
    // Nine real sessions and one husk — the count that fired `workouts:10` was ten,
    // and the ledger holds nine.
    stranded = makeProfile("STRANDED");
    addLogged(stranded, 9);
    addDraft(stranded);
    fire(stranded, "workouts:10", "workouts", 10);
    fire(stranded, "goal:1", "goal", 1);

    // Twelve real sessions: the same key, actually earned.
    earned = makeProfile("EARNED");
    addLogged(earned, 12);
    fire(earned, "workouts:10", "workouts", 10);

    // Both profiles start out holding the key, so neither outcome below is a
    // property of the fixture.
    expect(keysOf(stranded)).toEqual(["goal:1", "workouts:10"]);
    expect(keysOf(earned)).toEqual(["workouts:10"]);

    unstrand(db);
  });

  it("releases the key a husk consumed, so the real 10th can be recognized", () => {
    expect(keysOf(stranded)).not.toContain("workouts:10");
  });

  it("leaves the goal milestone beside it alone", () => {
    expect(keysOf(stranded)).toEqual(["goal:1"]);
  });

  it("keeps a key the ledger actually supports", () => {
    expect(keysOf(earned)).toEqual(["workouts:10"]);
  });

  it("is idempotent — a second run releases nothing further", () => {
    unstrand(db);
    expect(keysOf(stranded)).toEqual(["goal:1"]);
    expect(keysOf(earned)).toEqual(["workouts:10"]);
  });
});
