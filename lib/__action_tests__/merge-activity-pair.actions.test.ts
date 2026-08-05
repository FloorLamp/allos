// SERVER-ACTION TIER — the Data → Review duplicate resolver's activity merge
// (mergeActivityPair). This path is a plain cascade delete (NOT undoable), so the
// only integrity guarantee under test is issue #199: the discarded row's
// exercise_sets must be RE-PARENTED onto the keeper before the delete, never lost to
// the FK ON DELETE CASCADE.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { mergeActivityPair } from "@/app/(app)/data/review-actions";
import { getPairDecisions } from "@/lib/queries";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function insertActivity(
  profileId: number,
  over: Partial<{
    title: string;
    source: string | null;
    external_id: string | null;
  }> = {}
): number {
  const row = {
    title: "Run",
    source: null as string | null,
    external_id: null as string | null,
    ...over,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, edited)
         VALUES (?, '2026-05-01', 'strength', ?, ?, ?, 0)`
      )
      .run(profileId, row.title, row.source, row.external_id).lastInsertRowid
  );
}

function insertSet(activityId: number, exercise: string): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 60, 5)`
  ).run(activityId, exercise);
}

const setsFor = (activityId: number) =>
  (
    db
      .prepare(
        "SELECT exercise FROM exercise_sets WHERE activity_id = ? ORDER BY id"
      )
      .all(activityId) as { exercise: string }[]
  ).map((s) => s.exercise);

beforeEach(() => {
  revalidate.mockClear();
});

describe("mergeActivityPair (Review resolver)", () => {
  it("re-parents the discarded row's sets onto the keeper instead of cascading them away (#199)", async () => {
    const login = createLogin();
    const profile = createProfile("review-merge-sets", login.id);
    actAs(login, profile);

    // The imported row is the keeper (matching the resolver's default); the manual
    // strength log (with the typed-in sets) is discarded.
    const keepId = insertActivity(profile.id, {
      title: "Imported",
      source: "strava",
      external_id: "strava:review-1",
    });
    insertSet(keepId, "Overhead Press");
    const dropId = insertActivity(profile.id, { title: "Manual" });
    insertSet(dropId, "Back Squat");
    insertSet(dropId, "Deadlift");

    await mergeActivityPair(
      fd({ keep_id: keepId, drop_id: dropId, signature: "id:1|id:2" })
    );

    // Discarded row gone, its sets preserved on the keeper (none lost to cascade).
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(dropId)
    ).toBeUndefined();
    expect(setsFor(keepId)).toEqual([
      "Overhead Press",
      "Back Squat",
      "Deadlift",
    ]);
    // A durable 'merged' decision is still recorded on the stable signature.
    expect([...getPairDecisions(profile.id, ACTIVITY_DOMAIN).values()]).toEqual(
      ["merged"]
    );
  });

  // #2011: the rescued pair is exactly the case where the two rows' clocks
  // DISAGREE, and the merge is what settles which one the day keeps. The fold's
  // rule answers it — the keeper's own start/end win outright, and the discarded
  // row only ever fills a GAP — so keeping the correctly-offset copy leaves the
  // offset provider's hour behind rather than folding the defect back in. The
  // system never guesses which clock lied; the person picks the keeper (Review
  // shows both windows and now names the discrepancy) and the fold obeys.
  it("keeps the keeper's clock when merging a wrong-offset duplicate, never the discarded row's (#2011)", async () => {
    const login = createLogin();
    const profile = createProfile("review-merge-clock", login.id);
    actAs(login, profile);

    const keepId = insertActivity(profile.id, {
      title: "Walk",
      source: "health-connect",
      external_id: "health-connect:walk-1",
    });
    const dropId = insertActivity(profile.id, {
      title: "Afternoon Walk",
      source: "strava",
      external_id: "strava:walk-1",
    });
    // The keeper's honest window; the discarded Strava copy an hour early, plus a
    // distance the keeper lacks so the fold demonstrably still gap-fills.
    db.prepare(
      "UPDATE activities SET start_time = ?, end_time = ?, duration_min = ? WHERE id = ?"
    ).run("09:05", "09:30", 25, keepId);
    db.prepare(
      "UPDATE activities SET start_time = ?, end_time = ?, duration_min = ?, distance_km = ? WHERE id = ?"
    ).run("08:05", "08:30", 25, 2.11, dropId);

    await mergeActivityPair(
      fd({
        keep_id: keepId,
        drop_id: dropId,
        signature: "ext:health-connect:walk-1|ext:strava:walk-1",
      })
    );

    expect(
      db
        .prepare(
          "SELECT start_time, end_time, distance_km FROM activities WHERE id = ?"
        )
        .get(keepId)
    ).toEqual({ start_time: "09:05", end_time: "09:30", distance_km: 2.11 });
  });
});
