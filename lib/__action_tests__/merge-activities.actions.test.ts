// SERVER-ACTION TIER — the Journal's manual pair-merge (issue #64).
//
// Proves mergeActivities runs through the mocked auth guard and: folds the
// discarded row's gap-filling fields into the keeper (COALESCE(keep, drop)), marks
// the keeper edited=1, records a durable 'merged' pair decision, deletes the
// discarded row while returning an UNDO token, restores it via undoDelete, refuses a
// cross-day pair, and never reaches across profiles.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { mergeActivities } from "@/app/(app)/journal/actions";
import { undoDelete } from "@/app/(app)/undo/actions";
import { getPairDecisions } from "@/lib/queries";
import { ACTIVITY_DOMAIN } from "@/lib/import-review/detect";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function insertActivity(
  profileId: number,
  over: Partial<{
    date: string;
    type: string;
    title: string;
    notes: string | null;
    duration_min: number | null;
    distance_km: number | null;
    source: string | null;
    external_id: string | null;
    edited: number;
  }> = {}
): number {
  const row = {
    date: "2026-05-01",
    type: "cardio",
    title: "Run",
    notes: null,
    duration_min: null,
    distance_km: null,
    source: null,
    external_id: null,
    edited: 0,
    ...over,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, notes, duration_min, distance_km,
            source, external_id, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        row.date,
        row.type,
        row.title,
        row.notes,
        row.duration_min,
        row.distance_km,
        row.source,
        row.external_id,
        row.edited
      ).lastInsertRowid
  );
}

const activityRow = (id: number) =>
  db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;

// Insert one exercise_set onto an activity; returns its id.
function insertSet(activityId: number, exercise: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
         VALUES (?, ?, 1, 50, 5)`
      )
      .run(activityId, exercise).lastInsertRowid
  );
}

const setsFor = (activityId: number) =>
  db
    .prepare(
      "SELECT id, exercise FROM exercise_sets WHERE activity_id = ? ORDER BY id"
    )
    .all(activityId) as { id: number; exercise: string }[];

beforeEach(() => {
  revalidate.mockClear();
});

describe("mergeActivities", () => {
  it("folds gaps into the keeper, locks it edited=1, records a decision, deletes the drop", async () => {
    const login = createLogin();
    const profile = createProfile("merge-user", login.id);
    actAs(login, profile);

    // Keeper has notes + duration; drop supplies the missing distance.
    const keepId = insertActivity(profile.id, {
      title: "Morning run",
      notes: "hard effort",
      duration_min: 30,
    });
    const dropId = insertActivity(profile.id, {
      title: "GPS run",
      notes: "easy",
      duration_min: 99,
      distance_km: 5,
      source: "strava",
      external_id: "strava:1",
    });

    const { undoId } = await mergeActivities(
      fd({ keep_id: keepId, drop_id: dropId })
    );

    const keep = activityRow(keepId)!;
    expect(keep.notes).toBe("hard effort"); // keeper wins
    expect(keep.duration_min).toBe(30); // keeper wins
    expect(keep.distance_km).toBe(5); // filled from drop
    expect(keep.edited).toBe(1); // re-ingest lock
    expect(activityRow(dropId)).toBeUndefined(); // discarded row gone

    // A durable 'merged' decision keyed on the stable pair signature.
    const decisions = getPairDecisions(profile.id, ACTIVITY_DOMAIN);
    expect([...decisions.values()]).toEqual(["merged"]);

    expect(undoId).not.toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/training");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  // Issue #100: a conflict-preview override makes the keeper take the DISCARDED
  // row's value for one field, while every other field still folds keeper-wins.
  it("applies a per-field override to the discarded row's value", async () => {
    const login = createLogin();
    const profile = createProfile("merge-override", login.id);
    actAs(login, profile);

    // Both rows carry a REAL, differing duration — the conflict case.
    const keepId = insertActivity(profile.id, {
      title: "Keeper",
      duration_min: 42,
      distance_km: 5,
    });
    const dropId = insertActivity(profile.id, {
      title: "Dupe",
      duration_min: 51,
      distance_km: 5.1,
    });

    const { undoId } = await mergeActivities(
      fd({
        keep_id: keepId,
        drop_id: dropId,
        overrides: JSON.stringify(["duration_min"]),
      })
    );

    const keep = activityRow(keepId)!;
    expect(keep.duration_min).toBe(51); // overridden → discarded row's value
    expect(keep.distance_km).toBe(5); // not overridden → keeper's value wins
    expect(keep.edited).toBe(1);
    expect(activityRow(dropId)).toBeUndefined();
    expect(undoId).not.toBeNull();
  });

  // A client can only send field NAMES; an override naming a non-fold field (or a
  // value it invented) can never take effect — the server re-reads the drop row and
  // only ever writes that row's own value.
  it("ignores an override for a non-fold field name", async () => {
    const login = createLogin();
    const profile = createProfile("merge-override-junk", login.id);
    actAs(login, profile);

    const keepId = insertActivity(profile.id, {
      title: "Keeper",
      duration_min: 42,
    });
    const dropId = insertActivity(profile.id, {
      title: "Dupe",
      duration_min: 51,
    });

    await mergeActivities(
      fd({
        keep_id: keepId,
        drop_id: dropId,
        overrides: JSON.stringify(["id", "source", "title"]),
      })
    );

    // None of those are fold fields → the keeper-wins fold stands untouched.
    expect(activityRow(keepId)!.duration_min).toBe(42);
  });

  it("undo restores the discarded row from the returned token", async () => {
    const login = createLogin();
    const profile = createProfile("merge-undo", login.id);
    actAs(login, profile);

    const keepId = insertActivity(profile.id, { title: "Keep" });
    const dropId = insertActivity(profile.id, { title: "Drop" });

    const { undoId } = await mergeActivities(
      fd({ keep_id: keepId, drop_id: dropId })
    );
    expect(activityRow(dropId)).toBeUndefined();

    const { ok } = await undoDelete(undoId!);
    expect(ok).toBe(true);
    // The row comes back under a NEW id — the "Drop" title is present again.
    const restored = db
      .prepare(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND title = 'Drop'"
      )
      .get(profile.id) as { c: number };
    expect(restored.c).toBe(1);
  });

  // Issue #199: the discarded row's exercise_sets must survive the merge — they are
  // RE-PARENTED onto the keeper, never deleted by the FK cascade. The trap this
  // guards: a manual strength log (the row WITH sets) merged into an imported keeper
  // (the default keeper) must not silently destroy the typed-in sets.
  it("re-parents the discarded row's sets onto the keeper (#199)", async () => {
    const login = createLogin();
    const profile = createProfile("merge-sets", login.id);
    actAs(login, profile);

    // Keeper is the imported row (the default keeper) with its own set; the drop is
    // the manual strength log carrying the typed-in sets.
    const keepId = insertActivity(profile.id, {
      type: "strength",
      title: "Imported session",
      source: "strava",
      external_id: "strava:sets-1",
    });
    insertSet(keepId, "Bench Press");
    const dropId = insertActivity(profile.id, {
      type: "strength",
      title: "Manual session",
    });
    insertSet(dropId, "Back Squat");
    insertSet(dropId, "Deadlift");

    await mergeActivities(fd({ keep_id: keepId, drop_id: dropId }));

    // The discarded row is gone but ALL three sets now live on the keeper — none
    // were lost to the cascade.
    expect(activityRow(dropId)).toBeUndefined();
    const keeperSets = setsFor(keepId).map((s) => s.exercise);
    expect(keeperSets).toEqual(["Bench Press", "Back Squat", "Deadlift"]);
  });

  // Issue #200: undoing a merge fully inverts it — the recorded pair decision is
  // CLEARED (so the un-merged pair re-detects), the keeper's gap-fills (chiefly a
  // wholesale-inherited components array) are REVERTED (no double-count), and the
  // re-parented sets move BACK onto the restored row.
  it("undo fully inverts the merge: clears the decision, reverts keeper gap-fills, moves sets back (#200)", async () => {
    const login = createLogin();
    const profile = createProfile("merge-invert", login.id);
    actAs(login, profile);

    // Keeper carries NO components and no distance; the drop carries both plus a set.
    const keepId = insertActivity(profile.id, {
      type: "strength",
      title: "Keeper",
    });
    insertSet(keepId, "Bench Press");
    const dropId = insertActivity(profile.id, {
      type: "strength",
      title: "Drop",
      distance_km: 5,
    });
    const dropSetId = insertSet(dropId, "Back Squat");
    db.prepare("UPDATE activities SET components = ? WHERE id = ?").run(
      JSON.stringify([{ name: "Row", type: "cardio", distance_km: 2 }]),
      dropId
    );

    const { undoId } = await mergeActivities(
      fd({ keep_id: keepId, drop_id: dropId })
    );

    // Post-merge: the keeper absorbed the drop's components + distance and both sets.
    const mergedKeep = activityRow(keepId)!;
    expect(mergedKeep.components).not.toBeNull();
    expect(mergedKeep.distance_km).toBe(5);
    expect(setsFor(keepId)).toHaveLength(2);
    expect(getPairDecisions(profile.id, ACTIVITY_DOMAIN).size).toBe(1);

    // Undo.
    const { ok } = await undoDelete(undoId!);
    expect(ok).toBe(true);

    // The keeper is back to its pre-fold state — no inherited components, no distance
    // — so nothing double-counts with the restored row.
    const revertedKeep = activityRow(keepId)!;
    expect(revertedKeep.components).toBeNull();
    expect(revertedKeep.distance_km).toBeNull();
    // The keeper keeps ONLY its own set; the drop's set moved back onto the restored
    // row (re-inserted under a new id, carrying its original set).
    expect(setsFor(keepId).map((s) => s.exercise)).toEqual(["Bench Press"]);
    const restored = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND title = 'Drop'"
      )
      .get(profile.id) as { id: number };
    expect(setsFor(restored.id).map((s) => s.exercise)).toEqual(["Back Squat"]);
    // The original drop set row was moved (not duplicated): exactly one Back Squat
    // across this profile's activities.
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) c FROM exercise_sets es
               JOIN activities a ON a.id = es.activity_id
              WHERE a.profile_id = ? AND es.exercise = ?`
          )
          .get(profile.id, "Back Squat") as { c: number }
      ).c
    ).toBe(1);
    void dropSetId;

    // The recorded 'merged' decision is gone, so the live duplicate pair resurfaces.
    expect(getPairDecisions(profile.id, ACTIVITY_DOMAIN).size).toBe(0);
  });

  it("refuses a cross-day pair (no-op)", async () => {
    const login = createLogin();
    const profile = createProfile("merge-crossday", login.id);
    actAs(login, profile);

    const keepId = insertActivity(profile.id, { date: "2026-05-01" });
    const dropId = insertActivity(profile.id, { date: "2026-05-02" });

    const { undoId } = await mergeActivities(
      fd({ keep_id: keepId, drop_id: dropId })
    );
    expect(undoId).toBeNull();
    expect(activityRow(keepId)).toBeDefined();
    expect(activityRow(dropId)).toBeDefined(); // untouched
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("cannot merge across profiles (drop id belongs to another profile)", async () => {
    const login = createLogin();
    const profileA = createProfile("A", login.id);
    const profileB = createProfile("B", login.id);

    const keepId = insertActivity(profileA.id, { title: "A-keep" });
    const dropId = insertActivity(profileB.id, { title: "B-drop" });

    actAs(login, profileA);
    const { undoId } = await mergeActivities(
      fd({ keep_id: keepId, drop_id: dropId })
    );

    expect(undoId).toBeNull();
    expect(activityRow(keepId)).toBeDefined();
    expect(activityRow(dropId)).toBeDefined(); // B's row untouched
  });
});
