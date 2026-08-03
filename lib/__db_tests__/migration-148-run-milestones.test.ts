// DB INTEGRATION TIER — migration 148 (#1939).
//
// Retiring the `streak:` and `adherence:` milestone families is half a code change
// and half a one-shot data move: the engine stops minting them, and the rows it
// already minted are deleted, so the Timeline carries no badge the app no longer
// awards. This tier proves the second half, which the pure tier structurally
// cannot — and proves the two things a delete migration must never get wrong: it
// removes what it claims to, and it removes NOTHING else.
//
// The blast-radius half matters more than the removal half. `milestones` holds five
// discriminators; three of them (`workouts`, `goal`, `endurance`) survive this
// ruling, and one of those — the endurance-plan completion — is written by a
// different module entirely and keyed to a live plan row. A delete that over-reached
// would silently detach it.
//
// The migration body is a plain DELETE, so re-running `up` against the already-
// migrated test database is both safe and the point (idempotence is asserted below).
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic
// data only.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { migration as m148 } from "@/lib/migrations/versions/148-retire-run-milestones";
import { getTimelineEvents } from "@/lib/timeline";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

const ON = "2026-07-01";

function insertMilestone(
  profileId: number,
  key: string,
  kind: string,
  threshold: number,
  title: string
) {
  db.prepare(
    `INSERT INTO milestones (profile_id, key, kind, threshold, title, detail, achieved_on)
     VALUES (?, ?, ?, ?, ?, '', ?)`
  ).run(profileId, key, kind, threshold, title, ON);
}

// The five kinds the table has ever carried, planted as they were actually
// written — key AND kind — so the migration is exercised against real shapes.
function seedMilestones(profileId: number) {
  insertMilestone(
    profileId,
    "workouts:100",
    "workouts",
    100,
    "100 workouts logged"
  );
  insertMilestone(profileId, "goal:7", "goal", 7, "Goal reached: Run a 10k");
  insertMilestone(
    profileId,
    "endurance-plan:3",
    "endurance",
    3,
    "Event completed: 21.1 km run"
  );
  insertMilestone(
    profileId,
    "streak:30",
    "streak",
    30,
    "30-day activity streak"
  );
  insertMilestone(
    profileId,
    "adherence:7",
    "adherence",
    7,
    "7-day adherence streak"
  );
}

function keys(profileId: number): string[] {
  return (
    db
      .prepare("SELECT key FROM milestones WHERE profile_id = ? ORDER BY key")
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
}

describe("migration 148 — retiring the run-shaped milestone families (#1939)", () => {
  it("deletes the streak: and adherence: rows and keeps the other three kinds", () => {
    const p = newProfile("M148");
    seedMilestones(p);
    m148.up(db);

    expect(keys(p)).toEqual(["endurance-plan:3", "goal:7", "workouts:100"]);
  });

  it("deletes across EVERY profile — the ruling is not half-applied", () => {
    // The delete is deliberately unscoped (allowlisted in profile-scoping): a
    // per-profile loop would leave the retired badges standing on whichever
    // profile the loop missed.
    const a = newProfile("M148 A");
    const b = newProfile("M148 B");
    seedMilestones(a);
    seedMilestones(b);
    m148.up(db);

    for (const p of [a, b]) {
      expect(keys(p)).toEqual(["endurance-plan:3", "goal:7", "workouts:100"]);
    }
  });

  it("catches a row whose key and kind disagree (either discriminator is enough)", () => {
    const p = newProfile("M148 skew");
    // A hand-fixed / imported row with only one discriminator intact must not
    // survive on a technicality.
    insertMilestone(p, "streak:7", "workouts", 7, "7-day activity streak");
    insertMilestone(p, "legacy-key", "adherence", 7, "7-day adherence streak");
    insertMilestone(p, "workouts:10", "workouts", 10, "10 workouts logged");
    m148.up(db);

    expect(keys(p)).toEqual(["workouts:10"]);
  });

  it("is idempotent and a no-op on a profile that never earned one", () => {
    const p = newProfile("M148 clean");
    insertMilestone(p, "workouts:50", "workouts", 50, "50 workouts logged");
    m148.up(db);
    m148.up(db);

    expect(keys(p)).toEqual(["workouts:50"]);
  });

  it("leaves the endurance-plan completion attached to its live plan", () => {
    // The one surviving kind written by a DIFFERENT module (lib/endurance-plans),
    // keyed to a plan row that deletes its milestone by key. Over-reaching here
    // would orphan the plan's completion marker with nothing to notice it.
    const p = newProfile("M148 endurance");
    seedMilestones(p);
    m148.up(db);

    const row = db
      .prepare(
        "SELECT key, kind FROM milestones WHERE profile_id = ? AND key = 'endurance-plan:3'"
      )
      .get(p) as { key: string; kind: string } | undefined;
    expect(row).toEqual({ key: "endurance-plan:3", kind: "endurance" });
  });

  it("the Timeline renders the survivors and no longer surfaces the deleted ones", () => {
    // The milestone lane reads the table generically and derives its event id from
    // the row id at render time — there is no persisted side-state keyed to a
    // milestone row — so a deleted row simply stops producing an event.
    const p = newProfile("M148 timeline");
    seedMilestones(p);

    const before = getTimelineEvents(p, { category: "milestone" }).map(
      (e) => e.title
    );
    expect(before).toContain("30-day activity streak");
    expect(before).toContain("7-day adherence streak");

    m148.up(db);

    const after = getTimelineEvents(p, { category: "milestone" });
    const titles = after.map((e) => e.title);
    expect(titles).toContain("100 workouts logged");
    expect(titles).toContain("Goal reached: Run a 10k");
    expect(titles).toContain("Event completed: 21.1 km run");
    expect(titles).not.toContain("30-day activity streak");
    expect(titles).not.toContain("7-day adherence streak");
    // Every surviving milestone event still resolves to a real row — nothing was
    // left pointing at a deleted id.
    for (const e of after) {
      const id = Number(e.id.split(":")[1]);
      expect(
        db
          .prepare("SELECT id FROM milestones WHERE id = ? AND profile_id = ?")
          .get(id, p)
      ).toBeTruthy();
    }
  });
});
