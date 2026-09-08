// DB INTEGRATION TIER — real delete → undo round-trip (issue #30).
//
// The pure suite (lib/__tests__/undo-delete.test.ts) covers the registry + remap
// transforms. This file opens a real (temp) SQLite handle, deletes a row through
// captureDelete, and proves restoreDeletedRow puts the row AND its cascade children
// back, with parent↔child FKs intact (new ids). It also checks the retention sweep and
// cross-profile isolation.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  captureDelete,
  restoreDeletedRow,
  sweepDeletedRows,
} from "@/lib/undo-delete-db";
import { deleteEquipment } from "@/lib/equipment";
import { getStrengthByExercise } from "@/lib/queries";
import { UNDO_KINDS } from "@/lib/undo-delete";
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
  // Label composition (#2856) — the child entity whose absence from the capture would
  // restore a blend the upper-limit and interaction engines had gone blind to.
  db.prepare(
    `INSERT INTO intake_item_ingredients (item_id, name, amount_text, amount, unit, sort)
     VALUES (?, 'Zinc', '11 mg', 11, 'mg', 0)`
  ).run(p.supplementId);
});

const count = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { c: number }).c;

describe("equipment delete → undo", () => {
  function fixture() {
    const owner = seedProfile("EQUIPMENT UNDO");
    const profileId = owner.profileId;
    const equipmentId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, weight_kg, category, retired)
       VALUES (?, 'Original machine', 20, 'Machine', 1)`
        )
        .run(profileId).lastInsertRowid
    );
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, equipment_id)
       VALUES (?, '2026-08-01', 'strength', 'Equipment undo session', ?)`
        )
        .run(profileId, equipmentId).lastInsertRowid
    );
    const setId = Number(
      db
        .prepare(
          `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
       VALUES (?, 'Machine Chest Press', 1, 60, 5, ?)`
        )
        .run(activityId, equipmentId).lastInsertRowid
    );
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols (profile_id, name, start_date, equipment_id)
       VALUES (?, 'Equipment undo protocol', '2026-08-01', ?)`
        )
        .run(profileId, equipmentId).lastInsertRowid
    );
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals (profile_id, title, category, exercise, metric, target_weight_kg, equipment_id)
       VALUES (?, 'Equipment undo goal', 'strength', 'Machine Chest Press', 'weight', 80, ?)`
        )
        .run(profileId, equipmentId).lastInsertRowid
    );
    const links = [
      ["exercise_sets", setId],
      ["activities", activityId],
      ["protocols", protocolId],
      ["goals", goalId],
    ] as const;
    return {
      profileId,
      equipmentId,
      activityId,
      setId,
      protocolId,
      goalId,
      links,
    };
  }

  it("restores the original equipment and its load lane without replacing linked rows", () => {
    const f = fixture();
    const original = db
      .prepare("SELECT * FROM equipment WHERE id = ?")
      .get(f.equipmentId);
    const linksBefore = f.links.map(([table, id]) =>
      db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
    );
    const removed = deleteEquipment(f.profileId, f.equipmentId);
    if (removed.kind !== "deleted") throw new Error("Equipment delete failed");
    for (const [table, id] of f.links)
      expect(
        db.prepare(`SELECT equipment_id FROM ${table} WHERE id = ?`).get(id)
      ).toEqual({ equipment_id: null });
    expect(
      getStrengthByExercise(f.profileId, true).find(
        (row) => row.equipmentId === f.equipmentId
      )
    ).toBeUndefined();

    expect(restoreDeletedRow(f.profileId, removed.undoId)).toBe(true);
    expect(
      db.prepare("SELECT * FROM equipment WHERE id = ?").get(f.equipmentId)
    ).toEqual(original);
    expect(
      f.links.map(([table, id]) =>
        db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
      )
    ).toEqual(linksBefore);
    expect(
      getStrengthByExercise(f.profileId, true).find(
        (row) => row.equipmentId === f.equipmentId
      )
    ).toMatchObject({ topWeightKg: 60 });
    expect(restoreDeletedRow(f.profileId, removed.undoId)).toBe(false);
  });

  it("reconnects only surviving null links and keeps newer assignments and other edits", () => {
    const f = fixture();
    // The bulk dataset path invokes captureDelete directly and must detach identically.
    const undoId = captureDelete("equipment", f.profileId, f.equipmentId)!;
    const replacement = Number(
      db
        .prepare(
          "INSERT INTO equipment (profile_id, name) VALUES (?, 'Replacement')"
        )
        .run(f.profileId).lastInsertRowid
    );
    db.prepare("UPDATE exercise_sets SET weight_kg = 65 WHERE id = ?").run(
      f.setId
    );
    db.prepare("UPDATE activities SET equipment_id = ? WHERE id = ?").run(
      replacement,
      f.activityId
    );
    db.prepare("DELETE FROM protocols WHERE id = ?").run(f.protocolId);
    db.prepare("UPDATE goals SET title = 'Updated goal' WHERE id = ?").run(
      f.goalId
    );

    expect(restoreDeletedRow(f.profileId, undoId)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT weight_kg, equipment_id FROM exercise_sets WHERE id = ?"
        )
        .get(f.setId)
    ).toEqual({ weight_kg: 65, equipment_id: f.equipmentId });
    expect(
      db
        .prepare("SELECT equipment_id FROM activities WHERE id = ?")
        .get(f.activityId)
    ).toEqual({ equipment_id: replacement });
    expect(
      db.prepare("SELECT id FROM protocols WHERE id = ?").get(f.protocolId)
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT title, equipment_id FROM goals WHERE id = ?")
        .get(f.goalId)
    ).toEqual({ title: "Updated goal", equipment_id: f.equipmentId });
  });

  it("does not resurrect a separately deleted activity or its sets", () => {
    const f = fixture();
    const undoId = captureDelete("equipment", f.profileId, f.equipmentId)!;
    captureDelete("activity", f.profileId, f.activityId);
    expect(restoreDeletedRow(f.profileId, undoId)).toBe(true);
    expect(
      db.prepare("SELECT id FROM activities WHERE id = ?").get(f.activityId)
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM exercise_sets WHERE id = ?").get(f.setId)
    ).toBeUndefined();
  });

  it("keeps another profile outside capture and restore, and retains the token on an id collision", () => {
    const f = fixture();
    expect(captureDelete("equipment", p.profileId, f.equipmentId)).toBeNull();
    const undoId = captureDelete("equipment", f.profileId, f.equipmentId)!;
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(false);
    db.prepare(
      "INSERT INTO equipment (id, profile_id, name) VALUES (?, ?, 'Occupied id')"
    ).run(f.equipmentId, p.profileId);
    expect(() => restoreDeletedRow(f.profileId, undoId)).toThrow(/UNIQUE/);
    expect(
      db.prepare("SELECT name FROM equipment WHERE id = ?").get(f.equipmentId)
    ).toEqual({ name: "Occupied id" });
    expect(
      db.prepare("SELECT id FROM deleted_rows WHERE id = ?").get(undoId)
    ).toBeDefined();
    for (const [table, id] of f.links)
      expect(
        db.prepare(`SELECT equipment_id FROM ${table} WHERE id = ?`).get(id)
      ).toEqual({ equipment_id: null });
  });

  it("restores an older activity capture against the returned equipment identity", () => {
    const f = fixture();
    const activityUndo = captureDelete("activity", f.profileId, f.activityId)!;
    const equipmentUndo = captureDelete(
      "equipment",
      f.profileId,
      f.equipmentId
    )!;
    expect(restoreDeletedRow(f.profileId, equipmentUndo)).toBe(true);
    expect(restoreDeletedRow(f.profileId, activityUndo)).toBe(true);
    expect(
      getStrengthByExercise(f.profileId, true).find(
        (row) => row.equipmentId === f.equipmentId
      )
    ).toMatchObject({ topWeightKg: 60 });
  });

  it("does not repoint a linked activity or its sets after its profile changes", () => {
    const f = fixture();
    const undoId = captureDelete("equipment", f.profileId, f.equipmentId)!;
    db.prepare("UPDATE activities SET profile_id = ? WHERE id = ?").run(
      p.profileId,
      f.activityId
    );
    expect(restoreDeletedRow(f.profileId, undoId)).toBe(true);
    expect(
      db
        .prepare("SELECT equipment_id FROM activities WHERE id = ?")
        .get(f.activityId)
    ).toEqual({ equipment_id: null });
    expect(
      db
        .prepare("SELECT equipment_id FROM exercise_sets WHERE id = ?")
        .get(f.setId)
    ).toEqual({ equipment_id: null });
  });

  it("expires through the ordinary retention sweep", () => {
    const f = fixture();
    const undoId = captureDelete("equipment", f.profileId, f.equipmentId)!;
    db.prepare(
      "UPDATE deleted_rows SET deleted_at = datetime('now', '-31 days') WHERE id = ?"
    ).run(undoId);
    sweepDeletedRows(30);
    expect(restoreDeletedRow(f.profileId, undoId)).toBe(false);
    expect(
      db.prepare("SELECT id FROM equipment WHERE id = ?").get(f.equipmentId)
    ).toBeUndefined();
  });
});

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
  it("restores the item, doses, logs, pairs, courses, side effects and ingredients with FKs intact", () => {
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
    expect(
      count(
        "SELECT COUNT(*) c FROM intake_item_ingredients WHERE item_id = ?",
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

    // Composition came back on the restored item, canonical reading and all.
    const ingredient = db
      .prepare(
        "SELECT name, amount_text, amount, unit FROM intake_item_ingredients WHERE item_id = ?"
      )
      .get(newId) as
      | { name: string; amount_text: string; amount: number; unit: string }
      | undefined;
    expect(ingredient).toEqual({
      name: "Zinc",
      amount_text: "11 mg",
      amount: 11,
      unit: "mg",
    });
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

  it("nulls a clinical observation's document_id + provider_id when both targets were deleted after capture (#375)", () => {
    const q = seedProfile("BIO-UNDO");
    // A global provider (no profile_id) and a clinical observation linked to BOTH the
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
    const undoId = captureDelete("clinical-observation", q.profileId, recId)!;
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
             (profile_id, name, active, kind, condition, obligation, provider_id)
         VALUES (?, ?, 1, 'medication', 'daily', 'should', ?)`
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

// #598: two dangling-FK paths the #375 reconciliation missed — the merge-undo
// keeper's captured equipment_id, and the intake-item root's document_id — each
// re-inserted a captured FK verbatim, so deleting the target between capture and undo
// made the whole restore abort permanently.
describe("resilient restore on the merge-undo + intake-document FK paths (#598)", () => {
  it("nulls the merge keeper's captured equipment_id when the equipment was deleted after the merge", () => {
    const q = seedProfile("MERGE-EQUIP-UNDO");
    // A keeper activity carrying a piece of gear, and the discarded (drop) activity
    // the merge folded into it.
    const equipId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name) VALUES (?, 'MERGE Barbell')`
        )
        .run(q.profileId).lastInsertRowid
    );
    const keepId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min, equipment_id)
           VALUES (?, '2020-04-04', 'strength', 'MERGE Keeper', 40, ?)`
        )
        .run(q.profileId, equipId).lastInsertRowid
    );
    const dropId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, '2020-04-04', 'strength', 'MERGE Drop', 20)`
        )
        .run(q.profileId).lastInsertRowid
    );

    // Capture the drop with a merge-undo context whose keeperBefore snapshot holds
    // the pre-fold equipment_id (the value revertActivityMerge writes back).
    const undoId = captureDelete("activity", q.profileId, dropId, {
      keeperId: keepId,
      domain: "activity-dup",
      signature: "merge-equip-sig",
      keeperBefore: { equipment_id: equipId, edited: 0 },
      movedSetIds: [],
      movedRouteId: null,
    })!;

    // Delete the gear. deleteEquipment nulls only LIVE activities.equipment_id, so
    // the keeper's live row is nulled but the captured keeperBefore still holds equipId.
    deleteEquipment(q.profileId, equipId);
    expect(
      count("SELECT COUNT(*) c FROM equipment WHERE id = ?", equipId)
    ).toBe(0);

    // Undo must succeed (no FK throw) and leave the keeper's equipment_id NULL rather
    // than re-inserting the dead link.
    expect(restoreDeletedRow(q.profileId, undoId)).toBe(true);
    const keeper = db
      .prepare("SELECT equipment_id FROM activities WHERE id = ?")
      .get(keepId) as { equipment_id: number | null };
    expect(keeper.equipment_id).toBeNull();
  });

  it("nulls an extracted medication's document_id when its source document was deleted after capture", () => {
    const q = seedProfile("MED-DOC-UNDO");
    // A prescription auto-structured into a kind='medication' row (source='extracted',
    // document_id set) — the #414 shape the root's document_id externalRef guards.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, source, document_id)
         VALUES (?, ?, 1, 'medication', 'daily', 'should', 'extracted', ?)`
        )
        .run(q.profileId, `${q.tag} Metformin`, q.documentId).lastInsertRowid
    );

    // Delete the medication (captured with its live document_id), THEN delete the
    // source document — the captured copy still holds the now-dead document_id.
    const undoId = captureDelete("intake-item", q.profileId, itemId)!;
    db.prepare(
      "DELETE FROM medical_documents WHERE id = ? AND profile_id = ?"
    ).run(q.documentId, q.profileId);
    expect(
      count(
        "SELECT COUNT(*) c FROM medical_documents WHERE id = ?",
        q.documentId
      )
    ).toBe(0);

    // Undo must succeed (no FK throw) and restore the item with document_id NULLed.
    expect(restoreDeletedRow(q.profileId, undoId)).toBe(true);
    const item = db
      .prepare(
        "SELECT document_id FROM intake_items WHERE profile_id = ? AND name = ?"
      )
      .get(q.profileId, `${q.tag} Metformin`) as {
      document_id: number | null;
    };
    expect(item).toBeTruthy();
    expect(item.document_id).toBeNull();
  });
});

// Reflection guard closing the #375/#455/#598 gap class: every FK column on a
// captured table must be handled — remapped as an internal capture link (entity.fks),
// reconciled as an external ref (entity.externalRefs), or point at an always-present
// parent (profiles, which outlives the row and whose delete purges deleted_rows too).
// A new REFERENCES column added to any captured table without one of these fails here.
describe("captured FK columns are all internal, external, or profiles (#598 class)", () => {
  it("leaves no unhandled REFERENCES column on any undo kind's captured tables", () => {
    const ALWAYS_PRESENT = new Set(["profiles"]);
    const unhandled: string[] = [];
    for (const spec of Object.values(UNDO_KINDS)) {
      const tableByEntity = new Map(
        spec.entities.map((e) => [e.entity, e.table])
      );
      for (const entity of spec.entities) {
        const fks = db
          .prepare(`PRAGMA foreign_key_list(${entity.table})`)
          .all() as { table: string; from: string }[];
        for (const fk of fks) {
          // Surviving linked rows restore only the declared column, not the
          // other FKs on their table (which were never captured or deleted).
          if (entity.repoint && fk.from !== entity.repoint.column) continue;
          const internal = (entity.fks ?? []).some(
            (f) => f.column === fk.from && tableByEntity.get(f.ref) === fk.table
          );
          const external = (entity.externalRefs ?? []).some(
            (r) => r.column === fk.from && r.table === fk.table
          );
          if (!internal && !external && !ALWAYS_PRESENT.has(fk.table))
            unhandled.push(
              `${spec.kind}.${entity.entity}.${fk.from} -> ${fk.table}`
            );
        }
      }
    }
    expect(unhandled).toEqual([]);
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
    // Fresh row survives a one-day sweep (the window is DAYS since #2013).
    expect(sweepDeletedRows(1)).toBe(0);
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(1);
    // Backdate it past the window; now it's purged.
    db.prepare(
      "UPDATE deleted_rows SET deleted_at = datetime('now', '-2 days') WHERE id = ?"
    ).run(undoId);
    expect(sweepDeletedRows(1)).toBeGreaterThanOrEqual(1);
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(0);
  });
});
