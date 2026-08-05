// DB INTEGRATION TIER — Data → Trash (issue #2013).
//
// The pure suite (lib/__tests__/trash.test.ts) covers the derivation. This file opens
// a real (temp) SQLite handle and proves the four things a Trash has to get right and
// a 15-second toast never had to:
//
//   1. the retention sweep honours the CONFIGURED window rather than a hardcoded day;
//   2. restoring from the Trash is the SAME core as the toast's undo (one restore
//      path, not two that can drift);
//   3. "Delete permanently" removes exactly that capture — and Empty trash clears
//      only the ACTING profile's, leaving a household member's captures standing;
//   4. a bulk correction, which shares the table but is an inverted EDIT, is neither
//      listed nor swept up by either by-hand purge.
//
// The clip-file half (a purge must unlink the captured video files) lives in
// lib/__db_tests__/video-write.test.ts, where the video fixtures already are.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import {
  captureDelete,
  emptyTrash,
  purgeDeletedRow,
  restoreDeletedRow,
  sweepDeletedRows,
} from "@/lib/undo-delete-db";
import { listTrash, countTrash } from "@/lib/queries/trash";
import { getTrashRetentionDays, setTrashRetentionDays } from "@/lib/settings";
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
} from "@/lib/retention";
import { BULK_CORRECTION_KIND } from "@/lib/bulk-correction";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

beforeAll(() => {
  p = seedProfile("TRASH");
});

// A throwaway activity this test owns, so nothing here counts shared fixture rows.
function newActivity(profileId: number, title: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title)
         VALUES (?, ?, 'cardio', ?)`
      )
      .run(profileId, today(profileId), title).lastInsertRowid
  );
}

const backdate = (undoId: number, modifier: string) =>
  db
    .prepare(`UPDATE deleted_rows SET deleted_at = datetime('now', ?) WHERE id = ?`)
    .run(modifier, undoId);

const holdingRows = (undoId: number) =>
  (
    db
      .prepare(`SELECT COUNT(*) c FROM deleted_rows WHERE id = ?`)
      .get(undoId) as { c: number }
  ).c;

describe("the retention window is a setting, not a constant", () => {
  it("defaults to 30 days and round-trips a clamped admin value", () => {
    expect(getTrashRetentionDays()).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    setTrashRetentionDays(7);
    expect(getTrashRetentionDays()).toBe(7);
    // Out of range is clamped on the way in, so a hand-edited settings row can never
    // disable or unbound the sweep.
    setTrashRetentionDays(9_999);
    expect(getTrashRetentionDays()).toBe(MAX_TRASH_RETENTION_DAYS);
    setTrashRetentionDays(DEFAULT_TRASH_RETENTION_DAYS);
  });

  it("sweeps against the window it is GIVEN, in days", () => {
    const act = newActivity(p.profileId, "TRASH sweep window");
    const undoId = captureDelete("activity", p.profileId, act)!;
    expect(undoId).toBeTruthy();

    // Ten days old: under the 30-day default it survives — which is the whole point
    // of the feature, because under the old hardcoded day it would already be gone.
    backdate(undoId, "-10 days");
    sweepDeletedRows(DEFAULT_TRASH_RETENTION_DAYS);
    expect(holdingRows(undoId)).toBe(1);

    // The same row, the same age, a tighter admin-configured window → purged.
    expect(sweepDeletedRows(7)).toBeGreaterThanOrEqual(1);
    expect(holdingRows(undoId)).toBe(0);
  });
});

describe("listing the trash", () => {
  it("renders a capture with the payload's identifying content, newest first", () => {
    const older = newActivity(p.profileId, "TRASH list older");
    const olderUndo = captureDelete("activity", p.profileId, older)!;
    backdate(olderUndo, "-3 days");
    const newer = newActivity(p.profileId, "TRASH list newer");
    const newerUndo = captureDelete("activity", p.profileId, newer)!;

    const entries = listTrash(p.profileId, DEFAULT_TRASH_RETENTION_DAYS);
    const mine = entries.filter((e) => e.title?.startsWith("TRASH list"));
    expect(mine.map((e) => e.title)).toEqual([
      "TRASH list newer",
      "TRASH list older",
    ]);
    // The label column alone would say "activity" for both.
    expect(mine[0].label).toBe("activity");
    expect(mine[0].id).toBe(newerUndo);
    expect(mine[1].expiresInDays).toBeLessThan(mine[0].expiresInDays);

    purgeDeletedRow(p.profileId, olderUndo);
    purgeDeletedRow(p.profileId, newerUndo);
  });

  it("never surfaces another profile's captures", () => {
    const other = seedProfile("TRASH-OTHER");
    const act = newActivity(other.profileId, "TRASH-OTHER private");
    const undoId = captureDelete("activity", other.profileId, act)!;

    expect(listTrash(p.profileId, 30).map((e) => e.id)).not.toContain(undoId);
    expect(listTrash(other.profileId, 30).map((e) => e.id)).toContain(undoId);

    purgeDeletedRow(other.profileId, undoId);
  });
});

describe("restore from the Trash is the same core as undo", () => {
  it("puts the row and its children back through restoreDeletedRow", () => {
    const setsBefore = (
      db
        .prepare(`SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?`)
        .get(p.strengthActivityId) as { c: number }
    ).c;
    expect(setsBefore).toBe(2);

    const undoId = captureDelete(
      "activity",
      p.profileId,
      p.strengthActivityId
    )!;
    // It is visible in the Trash — the state that had no affordance before #2013.
    const entry = listTrash(p.profileId, 30).find((e) => e.id === undoId);
    expect(entry?.title).toBe(`${p.tag} Strength Day`);
    expect(entry?.childCount).toBe(setsBefore);

    // The Trash's Restore button calls undoDelete, which calls exactly this.
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);

    const restored = db
      .prepare(
        `SELECT id FROM activities WHERE profile_id = ? AND title = ?`
      )
      .get(p.profileId, `${p.tag} Strength Day`) as { id: number };
    expect(restored).toBeTruthy();
    // New id (restore never re-uses the deleted row's), children intact.
    expect(restored.id).not.toBe(p.strengthActivityId);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?`)
          .get(restored.id) as { c: number }
      ).c
    ).toBe(setsBefore);
    // The capture is consumed, so the Trash no longer offers it.
    expect(listTrash(p.profileId, 30).map((e) => e.id)).not.toContain(undoId);
  });
});

describe("delete permanently", () => {
  it("removes exactly that capture and reports a typed outcome", () => {
    const keep = newActivity(p.profileId, "TRASH purge keeper");
    const keepUndo = captureDelete("activity", p.profileId, keep)!;
    const drop = newActivity(p.profileId, "TRASH purge target");
    const dropUndo = captureDelete("activity", p.profileId, drop)!;

    expect(purgeDeletedRow(p.profileId, dropUndo)).toEqual({ kind: "purged" });
    expect(holdingRows(dropUndo)).toBe(0);
    expect(holdingRows(keepUndo)).toBe(1);

    // A second tap (or another tab's) is "gone", not a second purge — the surface
    // must not report a write it did not perform.
    expect(purgeDeletedRow(p.profileId, dropUndo)).toEqual({ kind: "gone" });

    purgeDeletedRow(p.profileId, keepUndo);
  });

  it("refuses another profile's token", () => {
    const other = seedProfile("TRASH-PURGE-OTHER");
    const act = newActivity(other.profileId, "TRASH-PURGE-OTHER row");
    const undoId = captureDelete("activity", other.profileId, act)!;

    expect(purgeDeletedRow(p.profileId, undoId)).toEqual({ kind: "gone" });
    expect(holdingRows(undoId)).toBe(1);
    // The rightful owner can.
    expect(purgeDeletedRow(other.profileId, undoId)).toEqual({ kind: "purged" });
  });

  it("a purged capture is unrestorable — the point of 'permanently'", () => {
    const act = newActivity(p.profileId, "TRASH purge unrestorable");
    const undoId = captureDelete("activity", p.profileId, act)!;
    expect(purgeDeletedRow(p.profileId, undoId)).toEqual({ kind: "purged" });
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(false);
  });
});

describe("empty trash", () => {
  it("clears the acting profile's captures and leaves another profile's intact", () => {
    const mine = seedProfile("TRASH-EMPTY-MINE");
    const theirs = seedProfile("TRASH-EMPTY-THEIRS");

    const mineUndos = ["a", "b"].map(
      (n) =>
        captureDelete(
          "activity",
          mine.profileId,
          newActivity(mine.profileId, `TRASH-EMPTY-MINE ${n}`)
        )!
    );
    const theirUndo = captureDelete(
      "activity",
      theirs.profileId,
      newActivity(theirs.profileId, "TRASH-EMPTY-THEIRS a")
    )!;

    expect(countTrash(mine.profileId)).toBe(2);
    expect(emptyTrash(mine.profileId)).toBe(2);

    expect(countTrash(mine.profileId)).toBe(0);
    for (const id of mineUndos) expect(holdingRows(id)).toBe(0);
    // The sweep is global instance maintenance; THIS is one person clearing theirs.
    expect(holdingRows(theirUndo)).toBe(1);
    expect(countTrash(theirs.profileId)).toBe(1);

    // Emptying an empty trash purges nothing, and says so.
    expect(emptyTrash(mine.profileId)).toBe(0);

    purgeDeletedRow(theirs.profileId, theirUndo);
  });
});

describe("a bulk correction shares the table but is not a deleted row", () => {
  // #1603 snapshots the INVERSE OF AN EDIT into deleted_rows to reuse the purge
  // timer. Its undo is undoBulkCorrection, not restoreDeletedRow, and it has its own
  // affordance on Data → Review — so the Trash must neither offer it a Restore button
  // that cannot work nor destroy it under "Empty trash".
  function seedCorrection(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO deleted_rows (profile_id, kind, label, payload)
           VALUES (?, ?, 'bulk correction', ?)`
        )
        .run(
          profileId,
          BULK_CORRECTION_KIND,
          JSON.stringify({ v: 1, field: "weight", changes: [] })
        ).lastInsertRowid
    );
  }

  it("is excluded from the list, the count, and both by-hand purges", () => {
    const owner = seedProfile("TRASH-BULK");
    const correctionId = seedCorrection(owner.profileId);
    const deleteUndo = captureDelete(
      "activity",
      owner.profileId,
      newActivity(owner.profileId, "TRASH-BULK deleted row")
    )!;

    expect(listTrash(owner.profileId, 30).map((e) => e.id)).toEqual([
      deleteUndo,
    ]);
    expect(countTrash(owner.profileId)).toBe(1);

    // Neither purge touches it.
    expect(purgeDeletedRow(owner.profileId, correctionId)).toEqual({
      kind: "gone",
    });
    expect(emptyTrash(owner.profileId)).toBe(1);
    expect(holdingRows(correctionId)).toBe(1);

    // The GLOBAL expiry sweep still takes it, on its own schedule.
    backdate(correctionId, "-2 days");
    sweepDeletedRows(1);
    expect(holdingRows(correctionId)).toBe(0);
  });
});
