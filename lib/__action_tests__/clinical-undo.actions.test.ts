// SERVER-ACTION TIER — the clinical delete actions speak the undo contract (#1847).
//
// Before this the passport's deletes returned a bare FormResult and the row was gone:
// there was no token, so no toast could offer Undo and Data → Trash had nothing to
// list. Each of the four now answers `{ undoId, error? }` — the useUndoableDelete
// shape — and, crucially, REFUSES with a typed error rather than reporting a delete it
// did not perform (an id that isn't this profile's captures nothing). `deleteEncounter`
// joined them as the fifth kind.
//
// The capture/restore fidelity itself is the DB tier (lib/__db_tests__/clinical-undo).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { deleteAllergy } from "@/app/(app)/records/problems/allergies/actions";
import { deleteCondition } from "@/app/(app)/records/problems/conditions/actions";
import { deleteImmunization } from "@/app/(app)/immunizations/actions";
import { deleteEncounter } from "@/app/(app)/encounters/actions";
import { restoreDeletedRow } from "@/lib/undo-delete-db";
import { seedActor, createProfile, fd } from "./harness";

const insert = (sql: string, ...args: unknown[]) =>
  Number(db.prepare(sql).run(...args).lastInsertRowid);

const newAllergy = (profileId: number, substance: string) =>
  insert(
    `INSERT INTO allergies (profile_id, substance, status) VALUES (?, ?, 'active')`,
    profileId,
    substance
  );
const newCondition = (profileId: number, name: string) =>
  insert(
    `INSERT INTO conditions (profile_id, name, status) VALUES (?, ?, 'active')`,
    profileId,
    name
  );
const newImmunization = (profileId: number, vaccine: string) =>
  insert(
    `INSERT INTO immunizations (profile_id, date, vaccine) VALUES (?, '2026-02-10', ?)`,
    profileId,
    vaccine
  );

const newEncounter = (profileId: number, reason: string) =>
  insert(
    `INSERT INTO encounters (profile_id, date, reason) VALUES (?, '2026-02-11', ?)`,
    profileId,
    reason
  );

const alive = (table: string, id: number) =>
  db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

describe("deleteAllergy (#1847)", () => {
  it("returns an undo token, and the token restores the allergy", async () => {
    const { profile } = seedActor();
    const id = newAllergy(profile.id, "Penicillin");

    const res = await deleteAllergy(fd({ id: String(id) }));
    expect(res.error).toBeUndefined();
    expect(typeof res.undoId).toBe("number");
    expect(alive("allergies", id)).toBe(false);

    expect(restoreDeletedRow(profile.id, res.undoId!)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT substance FROM allergies WHERE profile_id = ? AND substance = 'Penicillin'`
        )
        .get(profile.id)
    ).toBeTruthy();
  });

  it("refuses an id that isn't this profile's rather than reporting a delete", async () => {
    seedActor();
    const other = createProfile("OTHER-ALLERGY");
    const id = newAllergy(other.id, "Latex");

    const res = await deleteAllergy(fd({ id: String(id) }));
    expect(res.undoId).toBeNull();
    expect(res.error).toBeTruthy();
    // The other profile's row is untouched — the capture is profile-scoped.
    expect(alive("allergies", id)).toBe(true);
  });

  it("refuses a missing id", async () => {
    seedActor();
    const res = await deleteAllergy(fd({ id: "" }));
    expect(res).toEqual({ undoId: null, error: "Couldn't find that allergy." });
  });
});

describe("deleteCondition (#1847)", () => {
  it("returns an undo token and detaches a medication's indication link", async () => {
    const { profile } = seedActor();
    const conditionId = newCondition(profile.id, "Hypertension");
    const medId = insert(
      `INSERT INTO intake_items (profile_id, name, kind, indication_condition_id)
       VALUES (?, 'Lisinopril', 'medication', ?)`,
      profile.id,
      conditionId
    );

    const res = await deleteCondition(fd({ id: String(conditionId) }));
    expect(res.error).toBeUndefined();
    expect(typeof res.undoId).toBe("number");
    // The FK back-link is detached in the same transaction, so the delete lands.
    expect(
      db
        .prepare(
          `SELECT indication_condition_id AS c FROM intake_items WHERE id = ?`
        )
        .get(medId)
    ).toEqual({ c: null });

    expect(restoreDeletedRow(profile.id, res.undoId!)).toBe(true);
    expect(alive("intake_items", medId)).toBe(true);
  });

  it("refuses an id that isn't this profile's", async () => {
    seedActor();
    const other = createProfile("OTHER-CONDITION");
    const id = newCondition(other.id, "Asthma");
    const res = await deleteCondition(fd({ id: String(id) }));
    expect(res.undoId).toBeNull();
    expect(res.error).toBeTruthy();
    expect(alive("conditions", id)).toBe(true);
  });
});

describe("deleteImmunization (#1847)", () => {
  it("returns an undo token and still sweeps the un-backed dismissal", async () => {
    const { profile } = seedActor();
    const id = newImmunization(profile.id, "tdap");
    // A dismissal the deleted dose was the last backing for (#376): the sweep must
    // still run — undo deliberately does not re-silence a signal on the user's behalf.
    insert(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, 'immunization:tdap', datetime('now'))`,
      profile.id
    );

    const res = await deleteImmunization(fd({ id: String(id) }));
    expect(res.error).toBeUndefined();
    expect(typeof res.undoId).toBe("number");
    expect(alive("immunizations", id)).toBe(false);
    expect(
      db
        .prepare(
          `SELECT 1 FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = 'immunization:tdap'`
        )
        .get(profile.id)
    ).toBeUndefined();

    expect(restoreDeletedRow(profile.id, res.undoId!)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT vaccine FROM immunizations WHERE profile_id = ? AND vaccine = 'tdap'`
        )
        .get(profile.id)
    ).toBeTruthy();
  });

  it("refuses an id that isn't this profile's", async () => {
    seedActor();
    const other = createProfile("OTHER-IMMUNIZATION");
    const id = newImmunization(other.id, "mmr");
    const res = await deleteImmunization(fd({ id: String(id) }));
    expect(res.undoId).toBeNull();
    expect(res.error).toBeTruthy();
    expect(alive("immunizations", id)).toBe(true);
  });
});

describe("deleteEncounter (#1847)", () => {
  it("returns an undo token even for a visit other rows still point at", async () => {
    const { profile } = seedActor();
    const id = newEncounter(profile.id, "Annual physical");
    // An appointment kept as this visit: a REFERENCES with no ON DELETE, so before the
    // detach moved into captureDelete this delete could only work from the one action —
    // and the bulk path threw on the FK.
    const apptId = insert(
      `INSERT INTO appointments (profile_id, date, title, status, encounter_id)
       VALUES (?, '2026-02-11', 'Annual physical', 'completed', ?)`,
      profile.id,
      id
    );

    const res = await deleteEncounter(fd({ id: String(id) }));
    expect(res.error).toBeUndefined();
    expect(typeof res.undoId).toBe("number");
    expect(alive("encounters", id)).toBe(false);
    // Detached, not destroyed — and its completion survives.
    expect(
      db
        .prepare(`SELECT status, encounter_id FROM appointments WHERE id = ?`)
        .get(apptId)
    ).toEqual({ status: "completed", encounter_id: null });

    expect(restoreDeletedRow(profile.id, res.undoId!)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT reason FROM encounters WHERE profile_id = ? AND date = '2026-02-11'`
        )
        .get(profile.id)
    ).toEqual({ reason: "Annual physical" });
  });

  it("refuses an id that isn't this profile's", async () => {
    seedActor();
    const other = createProfile("OTHER-ENCOUNTER");
    const id = newEncounter(other.id, "Urgent care");
    const res = await deleteEncounter(fd({ id: String(id) }));
    expect(res.undoId).toBeNull();
    expect(res.error).toBeTruthy();
    expect(alive("encounters", id)).toBe(true);
  });
});
