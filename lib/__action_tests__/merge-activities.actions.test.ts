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
