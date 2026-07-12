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
import { deleteEquipment } from "@/lib/equipment";
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
        "SELECT COUNT(*) c FROM intake_item_doses WHERE item_id = ?",
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
      .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
      .get(newId) as { id: number } | undefined;
    expect(dose).toBeTruthy();
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_logs WHERE item_id = ? AND dose_id = ?",
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

// #202: a captured FK target can be deleted between capture and undo. Restore must
// reconcile the dangling link (null it / drop the join row) instead of throwing on
// a verbatim re-insert, and the batch path must isolate one poisoned token from the
// rest.
describe("resilient restore when a captured FK target was deleted meanwhile", () => {
  it("nulls a set's equipment_id when the equipment was deleted after the activity", () => {
    const q = seedProfile("EQUIP-UNDO");
    // A strength activity whose set references a piece of equipment.
    const actId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, '2020-02-02', 'strength', 'EQUIP Session', 30)`
        )
        .run(q.profileId).lastInsertRowid
    );
    const equipId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name) VALUES (?, 'EQUIP Barbell')`
        )
        .run(q.profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
       VALUES (?, 'Bench Press', 1, 60, 5, ?)`
    ).run(actId, equipId);

    // Delete the activity (its set — with equipment_id = equipId — is captured), THEN
    // delete the equipment. deleteEquipment nulls only LIVE sets, so the captured
    // copy still carries equipId, which no longer exists.
    const undoId = captureDelete("activity", q.profileId, actId)!;
    deleteEquipment(q.profileId, equipId);
    expect(
      count("SELECT COUNT(*) c FROM equipment WHERE id = ?", equipId)
    ).toBe(0);

    // Undo must succeed (no FK throw) and restore the set with equipment_id NULLed.
    expect(restoreDeletedRow(q.profileId, undoId)).toBe(true);
    const restored = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = ? AND title = 'EQUIP Session'"
      )
      .get(q.profileId) as { id: number };
    const set = db
      .prepare("SELECT equipment_id FROM exercise_sets WHERE activity_id = ?")
      .get(restored.id) as { equipment_id: number | null };
    expect(set.equipment_id).toBeNull();
  });

  it("nulls a biomarker record's document_id + provider_id when both targets were deleted after capture (#375)", () => {
    const q = seedProfile("BIO-UNDO");
    // A global provider (no profile_id) and a biomarker record linked to BOTH the
    // seeded source document and that provider — the two real enforced FKs migration
    // 006 added to medical_records.
    const providerId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key) VALUES ('BIO Clinic', 'organization', ?)`
        )
        .run(`bio-clinic-${q.profileId}`).lastInsertRowid
    );
    const recId = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, unit, canonical_name, value_num, provider_id, document_id)
           VALUES (?, '2020-03-03', 'lab', 'Glucose', '95', 'mg/dL', 'Glucose', 95, ?, ?)`
        )
        .run(q.profileId, providerId, q.documentId).lastInsertRowid
    );

    // Delete the record (captured with its live document_id + provider_id), THEN delete
    // the source document and the provider — mirroring "delete a record, then delete
    // its whole document" and "merge/delete the provider". The captured copy still
    // holds both now-dead ids.
    const undoId = captureDelete("biomarker-record", q.profileId, recId)!;
    db.prepare(
      "DELETE FROM medical_documents WHERE id = ? AND profile_id = ?"
    ).run(q.documentId, q.profileId);
    db.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
    expect(
      count(
        "SELECT COUNT(*) c FROM medical_documents WHERE id = ?",
        q.documentId
      )
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) c FROM providers WHERE id = ?", providerId)
    ).toBe(0);

    // Undo must succeed (no FK throw) and restore the record with BOTH provenance links
    // NULLed rather than re-inserting a dangling FK.
    expect(restoreDeletedRow(q.profileId, undoId)).toBe(true);
    const rec = db
      .prepare(
        "SELECT document_id, provider_id FROM medical_records WHERE profile_id = ? AND date = '2020-03-03' AND canonical_name = 'Glucose'"
      )
      .get(q.profileId) as {
      document_id: number | null;
      provider_id: number | null;
    };
    expect(rec).toBeTruthy();
    expect(rec.document_id).toBeNull();
    expect(rec.provider_id).toBeNull();
  });

  it("nulls an intake item's provider_id when the prescriber was merged/deleted after capture (#455)", () => {
    const q = seedProfile("RX-UNDO");
    // A global prescriber and a medication linked to it via provider_id — the same
    // real enforced FK migration 006 added to intake_items.
    const providerId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key) VALUES ('RX Clinic', 'organization', ?)`
        )
        .run(`rx-clinic-${q.profileId}`).lastInsertRowid
    );
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, provider_id)
           VALUES (?, ?, 1, 'medication', 'daily', 'high', ?)`
        )
        .run(q.profileId, `${q.tag} Atorvastatin`, providerId).lastInsertRowid
    );

    // Delete the medication (captured with its live provider_id), THEN delete the
    // prescriber — mirroring "merge/delete the provider" after the item was captured.
    // The captured copy still holds the now-dead provider id.
    const undoId = captureDelete("intake-item", q.profileId, itemId)!;
    db.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
    expect(
      count("SELECT COUNT(*) c FROM providers WHERE id = ?", providerId)
    ).toBe(0);

    // Undo must succeed (no FK throw) and restore the item with the dangling
    // prescriber link NULLed rather than re-inserting a dead FK.
    expect(restoreDeletedRow(q.profileId, undoId)).toBe(true);
    const item = db
      .prepare(
        "SELECT provider_id FROM intake_items WHERE profile_id = ? AND name = ?"
      )
      .get(q.profileId, `${q.tag} Atorvastatin`) as {
      provider_id: number | null;
    };
    expect(item).toBeTruthy();
    expect(item.provider_id).toBeNull();
  });

  it("drops a pair whose far endpoint item was deleted, still restoring the item", () => {
    const q = seedProfile("PAIR-UNDO");
    // Pair the tracked supplement (X) with the medication (Y).
    db.prepare(
      `INSERT INTO intake_item_pairs (a_id, b_id, relation) VALUES (?, ?, 'with')`
    ).run(q.supplementId, q.medicationId);

    // Delete X (the pair (X,Y) is captured), THEN delete Y so the captured pair's far
    // endpoint no longer exists.
    const undoId = captureDelete("intake-item", q.profileId, q.supplementId)!;
    db.prepare("DELETE FROM intake_items WHERE id = ? AND profile_id = ?").run(
      q.medicationId,
      q.profileId
    );
    expect(
      count("SELECT COUNT(*) c FROM intake_items WHERE id = ?", q.medicationId)
    ).toBe(0);

    // Undo restores X (no FK throw) but drops the now-unrestorable pair.
    expect(restoreDeletedRow(q.profileId, undoId)).toBe(true);
    const item = db
      .prepare(
        "SELECT id FROM intake_items WHERE profile_id = ? AND name = 'PAIR-UNDO Vitamin D'"
      )
      .get(q.profileId) as { id: number };
    expect(item).toBeTruthy();
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_pairs WHERE a_id = ? OR b_id = ?",
        item.id,
        item.id
      )
    ).toBe(0);
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
