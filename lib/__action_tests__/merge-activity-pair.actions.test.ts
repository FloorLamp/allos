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
});
