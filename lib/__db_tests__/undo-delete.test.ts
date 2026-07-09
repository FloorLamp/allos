// DB INTEGRATION TIER — real delete → undo round-trip (issue #30).
//
// The pure suite (lib/__tests__/undo-delete.test.ts) covers the registry + remap
// transforms. This file opens a real (temp) SQLite handle, deletes a row through
// captureDelete, and proves restoreDeletedRow puts the row AND its cascade children
// back, with parent↔child FKs intact (new ids). It also checks the 24h sweep and
// cross-profile isolation.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  captureDelete,
  restoreDeletedRow,
  sweepDeletedRows,
} from "@/lib/undo-delete-db";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

beforeAll(() => {
  p = seedProfile("UNDO");
  // Give the supplement a full cascade to exercise every child entity: a pair with
  // the medication, a medication course, and a side effect linked to that course.
  db.prepare(
    `INSERT INTO intake_item_pairs (a_id, b_id, relation) VALUES (?, ?, 'with')`
  ).run(p.supplementId, p.medicationId);
  const courseId = Number(
    db
      .prepare(
        `INSERT INTO medication_courses (item_id, started_on) VALUES (?, '2020-01-01')`
      )
      .run(p.supplementId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_side_effects (item_id, course_id, effect) VALUES (?, ?, 'nausea')`
  ).run(p.supplementId, courseId);
});

const count = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { c: number }).c;

describe("activity delete → undo", () => {
  it("captures the activity + its sets, then restores them (new ids)", () => {
    const setsBefore = count(
      "SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?",
      p.strengthActivityId
    );
    expect(setsBefore).toBe(2);

    const undoId = captureDelete("activity", p.profileId, p.strengthActivityId);
    expect(undoId).not.toBeNull();

    // Gone from the live tables; one holding row captured.
    expect(
      count(
        "SELECT COUNT(*) c FROM activities WHERE id = ?",
        p.strengthActivityId
      )
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?",
        p.strengthActivityId
      )
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) c FROM deleted_rows WHERE id = ? AND profile_id = ?",
        undoId,
        p.profileId
      )
    ).toBe(1);

    const ok = restoreDeletedRow(p.profileId, undoId!);
    expect(ok).toBe(true);

    // Restored under a NEW activity id, with both sets re-linked to it, and the
    // holding row consumed.
    const restored = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND title = 'UNDO Strength Day'"
      )
      .get(p.profileId) as { id: number } | undefined;
    expect(restored).toBeTruthy();
    expect(
      count(
        "SELECT COUNT(*) c FROM exercise_sets WHERE activity_id = ?",
        restored!.id
      )
    ).toBe(2);
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(0);
  });
});

describe("intake-item delete → undo (full cascade)", () => {
  it("restores the item, doses, logs, pairs, courses, and side effects with FKs intact", () => {
    const undoId = captureDelete("intake-item", p.profileId, p.supplementId);
    expect(undoId).not.toBeNull();

    // Parent + every child cascade-deleted.
    expect(
      count("SELECT COUNT(*) c FROM intake_items WHERE id = ?", p.supplementId)
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_doses WHERE supplement_id = ?",
        p.supplementId
      )
    ).toBe(0);
    // The pair endpoint on the still-existing medication side is also gone.
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_pairs WHERE a_id = ? OR b_id = ?",
        p.supplementId,
        p.supplementId
      )
    ).toBe(0);

    const ok = restoreDeletedRow(p.profileId, undoId!);
    expect(ok).toBe(true);

    const item = db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? AND name = 'UNDO Vitamin D'"
      )
      .get(p.profileId) as { id: number } | undefined;
    expect(item).toBeTruthy();
    const newId = item!.id;

    // A dose came back; its log points at the RESTORED dose (remapped dose_id).
    const dose = db
      .prepare("SELECT id FROM intake_item_doses WHERE supplement_id = ?")
      .get(newId) as { id: number } | undefined;
    expect(dose).toBeTruthy();
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_logs WHERE supplement_id = ? AND dose_id = ?",
        newId,
        dose!.id
      )
    ).toBe(1);

    // The pair's far endpoint (the medication) is preserved unchanged; its near
    // endpoint now points at the restored item.
    const pair = db
      .prepare(
        "SELECT a_id, b_id FROM intake_item_pairs WHERE a_id = ? OR b_id = ?"
      )
      .get(newId, newId) as { a_id: number; b_id: number } | undefined;
    expect(pair).toBeTruthy();
    expect([pair!.a_id, pair!.b_id]).toContain(newId);
    expect([pair!.a_id, pair!.b_id]).toContain(p.medicationId);

    // Course + side effect restored, and the side effect's course_id remaps to the
    // restored course.
    const course = db
      .prepare("SELECT id FROM medication_courses WHERE item_id = ?")
      .get(newId) as { id: number } | undefined;
    expect(course).toBeTruthy();
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_side_effects WHERE item_id = ? AND course_id = ?",
        newId,
        course!.id
      )
    ).toBe(1);
  });
});

describe("guards", () => {
  it("captureDelete returns null for a row that isn't this profile's", () => {
    const other = seedProfile("OTHER");
    expect(captureDelete("body-metric", p.profileId, 999999)).toBeNull();
    // A real row, wrong profile → not found → null (nothing deleted).
    const bm = db
      .prepare("SELECT id FROM body_metrics WHERE profile_id = ?")
      .get(other.profileId) as { id: number };
    expect(captureDelete("body-metric", p.profileId, bm.id)).toBeNull();
    expect(
      count("SELECT COUNT(*) c FROM body_metrics WHERE id = ?", bm.id)
    ).toBe(1);
  });

  it("restoreDeletedRow refuses another profile's undo token", () => {
    const other = seedProfile("OTHER2");
    const bm = db
      .prepare("SELECT id FROM body_metrics WHERE profile_id = ?")
      .get(other.profileId) as { id: number };
    const undoId = captureDelete("body-metric", other.profileId, bm.id)!;
    // p can't restore other's token.
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(false);
    // The rightful owner can.
    expect(restoreDeletedRow(other.profileId, undoId)).toBe(true);
  });

  it("sweepDeletedRows purges rows older than the window, keeps fresh ones", () => {
    const other = seedProfile("SWEEP");
    const bm = db
      .prepare("SELECT id FROM body_metrics WHERE profile_id = ?")
      .get(other.profileId) as { id: number };
    const undoId = captureDelete("body-metric", other.profileId, bm.id)!;
    // Fresh row survives a 24h sweep.
    expect(sweepDeletedRows(24)).toBe(0);
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(1);
    // Backdate it past the window; now it's purged.
    db.prepare(
      "UPDATE deleted_rows SET deleted_at = datetime('now', '-2 days') WHERE id = ?"
    ).run(undoId);
    expect(sweepDeletedRows(24)).toBeGreaterThanOrEqual(1);
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(0);
  });
});
