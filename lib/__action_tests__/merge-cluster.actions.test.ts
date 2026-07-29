// SERVER-ACTION TIER — the N-way cluster merge + keeper-selectable Journal merge
// (#1081). Proves:
//   - mergeActivityCluster re-verifies EVERY id against the acting profile (a
//     cross-profile drop is skipped, never folded/deleted), tombstones dropped
//     integration rows, and records a merged decision per constituent pair;
//   - the Journal mergeActivities, given a NON-card keeper, absorbs the originating
//     card, and the batch undo restores ALL dropped rows + their sets + the keeper's
//     pre-fold fields.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { mergeActivityCluster } from "@/app/(app)/data/review-actions";
import { mergeActivities } from "@/app/(app)/training/activity-actions";
import { undoDeletes } from "@/app/(app)/undo-actions";
import { getPairDecisions } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  pairSignature,
  activityToken,
} from "@/lib/import-review/detect";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-06-15";

function insertActivity(
  profileId: number,
  o: Partial<{
    title: string;
    source: string | null;
    external_id: string | null;
    notes: string | null;
    avg_hr: number | null;
    start_time: string;
    end_time: string;
  }> = {}
): number {
  const r = {
    title: "Run",
    source: null as string | null,
    external_id: null as string | null,
    notes: null as string | null,
    avg_hr: null as number | null,
    start_time: "08:00",
    end_time: "08:30",
    ...o,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, source, external_id, notes, avg_hr,
            duration_min, distance_km, start_time, end_time, edited)
         VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, 30, 5, ?, ?, 0)`
      )
      .run(
        profileId,
        DATE,
        r.title,
        r.source,
        r.external_id,
        r.notes,
        r.avg_hr,
        r.start_time,
        r.end_time
      ).lastInsertRowid
  );
}
function insertSet(activityId: number, exercise: string): void {
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 40, 5)`
  ).run(activityId, exercise);
}
const alive = (id: number) =>
  db.prepare("SELECT 1 FROM activities WHERE id = ?").get(id) !== undefined;
const setCount = (activityId: number) =>
  (
    db
      .prepare("SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?")
      .get(activityId) as { c: number }
  ).c;

beforeEach(() => {
  revalidate.mockClear();
});

describe("mergeActivityCluster — profile scoping (#1081)", () => {
  it("skips a cross-profile drop and merges only the acting profile's rows", async () => {
    const login = createLogin();
    const mine = createProfile("mine", login.id);
    const other = createProfile("other", login.id);
    actAs(login, mine);

    const keep = insertActivity(mine.id, { title: "keeper", notes: "own" });
    const dropMine = insertActivity(mine.id, {
      title: "mine dupe",
      source: "strava",
      external_id: "strava:1",
      start_time: "08:01",
      end_time: "08:31",
    });
    const dropOther = insertActivity(other.id, { title: "other-profile row" });

    const sig = pairSignature(
      activityToken({ id: keep, external_id: null }),
      activityToken({ id: dropMine, external_id: "strava:1" })
    );
    await mergeActivityCluster(
      fd({
        keep_id: keep,
        drop_ids: JSON.stringify([dropMine, dropOther]),
        pair_signatures: JSON.stringify([sig]),
      })
    );

    // The acting profile's drop is folded away; the cross-profile row is untouched.
    expect(alive(keep)).toBe(true);
    expect(alive(dropMine)).toBe(false);
    expect(alive(dropOther)).toBe(true);
    // The dropped Strava row is tombstoned; a merged decision is recorded.
    expect(
      db
        .prepare(
          "SELECT 1 FROM import_tombstones WHERE profile_id = ? AND natural_key = 'strava:1'"
        )
        .get(mine.id)
    ).toBeTruthy();
    expect([...getPairDecisions(mine.id, ACTIVITY_DOMAIN).values()]).toEqual([
      "merged",
    ]);
  });
});

describe("mergeActivities — non-card keeper + N-way undo (#1081)", () => {
  it("absorbs the originating card when a sibling is keeper, and undo restores everything", async () => {
    const login = createLogin();
    const profile = createProfile("journal", login.id);
    actAs(login, profile);

    // Originating card + two siblings, same day.
    const card = insertActivity(profile.id, {
      title: "card",
      notes: "card-notes",
    });
    insertSet(card, "card-set");
    const sib1 = insertActivity(profile.id, {
      title: "sib1",
      source: "strava",
      external_id: "strava:k",
      avg_hr: 150,
      start_time: "08:01",
      end_time: "08:31",
    });
    insertSet(sib1, "sib1-set");
    const sib2 = insertActivity(profile.id, {
      title: "sib2",
      start_time: "08:02",
      end_time: "08:32",
    });
    insertSet(sib2, "sib2-set");

    // Keeper = sib1 (a sibling): the originating card is itself a drop.
    const { undoIds } = await mergeActivities(
      fd({ keep_id: sib1, drop_ids: JSON.stringify([card, sib2]) })
    );
    expect(undoIds).toHaveLength(2);

    // The card + sib2 are absorbed; sib1 survives with all three sets + gap-filled notes.
    expect(alive(card)).toBe(false);
    expect(alive(sib2)).toBe(false);
    expect(alive(sib1)).toBe(true);
    expect(setCount(sib1)).toBe(3);
    const keeper = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(sib1) as Record<string, unknown>;
    expect(keeper.notes).toBe("card-notes"); // gap-filled from a drop
    expect(keeper.edited).toBe(1);

    // Undo the whole N-way merge: every dropped row returns (new ids) with its own set,
    // and the keeper's pre-fold fields are restored (notes back to null).
    const { restored } = await undoDeletes(undoIds);
    expect(restored).toBe(2);
    expect(setCount(sib1)).toBe(1); // sib1's own set only
    const keeperAfter = db
      .prepare("SELECT * FROM activities WHERE id = ?")
      .get(sib1) as Record<string, unknown>;
    expect(keeperAfter.notes).toBeNull(); // pre-fold restore
    // The originating card is back (restored under a new id, same title + set).
    const restoredCard = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND title = 'card'"
      )
      .get(profile.id) as { id: number } | undefined;
    expect(restoredCard).toBeTruthy();
    expect(setCount(restoredCard!.id)).toBe(1);
    const restoredSib2 = db
      .prepare(
        "SELECT 1 FROM activities WHERE profile_id = ? AND title = 'sib2'"
      )
      .get(profile.id);
    expect(restoredSib2).toBeTruthy();
  });
});
