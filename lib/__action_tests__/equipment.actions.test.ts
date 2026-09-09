// SERVER-ACTION TIER — equipment write path (issue #341).
//
// Covers create (stored shape + retired default), the soft-retire toggle, and that
// retired rows drop out of the default getEquipment read while a hard delete still
// nulls the referencing set link.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createEquipmentAction,
  setEquipmentRetiredAction,
  deleteEquipmentAction,
} from "@/app/(app)/equipment/actions";
import { getEquipment } from "@/lib/equipment";
import { undoDelete } from "@/app/(app)/undo-actions";
import { deleteDatasetRows } from "@/app/(app)/data/manage-actions";
import { prStrengthDismissalKey } from "@/lib/dismissal-keys";
import { setStoredAge } from "@/lib/settings";
import {
  actAs,
  createLogin,
  createProfile,
  seedActor as seedActorWithoutAge,
} from "./harness";

function seedActor() {
  const actor = seedActorWithoutAge();
  setStoredAge(actor.profile.id, 30);
  return actor;
}

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

describe("createEquipmentAction", () => {
  it("keeps all new activity equipment out of early childhood", async () => {
    const login = createLogin();
    const profile = createProfile("child-equipment", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 4);

    const result = await createEquipmentAction({
      name: "Trap Bar",
      weight_kg: 25,
      category: "Barbell",
    });
    expect(result).toMatchObject({ ok: false });
    expect(
      await createEquipmentAction({
        name: "Balance Bike",
        weight_kg: null,
        category: "Bike",
      })
    ).toMatchObject({ ok: false });
    expect(getEquipment(profile.id)).toHaveLength(0);
  });

  it("stores a row with category and retired=0, and revalidates", async () => {
    const { profile } = seedActor();
    const res = await createEquipmentAction({
      name: "Trap Bar",
      weight_kg: 25,
      category: "Barbell",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.equipment.category).toBe("Barbell");
    expect(res.equipment.retired).toBe(0);
    expect(revalidate).toHaveBeenCalledWith("/equipment");

    const rows = getEquipment(profile.id);
    expect(rows.map((e) => e.name)).toContain("Trap Bar");
  });

  it("rejects a duplicate name (case-insensitive)", async () => {
    seedActor();
    await createEquipmentAction({
      name: "Kettlebell",
      weight_kg: 16,
      category: "Kettlebell",
    });
    const dup = await createEquipmentAction({
      name: "kettlebell",
      weight_kg: 24,
      category: "Kettlebell",
    });
    expect(dup.ok).toBe(false);
  });
});

describe("setEquipmentRetiredAction", () => {
  it("hides a retired row from the default read and restores it on un-retire", async () => {
    const { profile } = seedActor();
    const created = await createEquipmentAction({
      name: "Old Bike",
      weight_kg: null,
      category: "Bike",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.equipment.id;

    await setEquipmentRetiredAction(id, true);
    expect(getEquipment(profile.id).map((e) => e.id)).not.toContain(id);
    expect(
      getEquipment(profile.id, { includeRetired: true }).map((e) => e.id)
    ).toContain(id);

    await setEquipmentRetiredAction(id, false);
    expect(getEquipment(profile.id).map((e) => e.id)).toContain(id);
  });

  // #2138: the retire is a state-named CAS with typed, changes-checked outcomes —
  // the action must never confirm a flip that did not land.
  it("retiring twice reports the already-retired refusal, not success", async () => {
    seedActor();
    const created = await createEquipmentAction({
      name: "Sold Bike",
      weight_kg: null,
      category: "Bike",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.equipment.id;

    expect(await setEquipmentRetiredAction(id, true)).toEqual({ ok: true });
    const again = await setEquipmentRetiredAction(id, true);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toMatch(/already retired/);

    // The inverse refusal: restoring a row that is already active.
    expect(await setEquipmentRetiredAction(id, false)).toEqual({ ok: true });
    const activeAgain = await setEquipmentRetiredAction(id, false);
    expect(activeAgain.ok).toBe(false);
  });

  it("a forged id reports not-found instead of { ok: true }", async () => {
    seedActor();
    const res = await setEquipmentRetiredAction(99999, true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/find that equipment/);
  });
});

describe("deleteEquipmentAction", () => {
  it("returns an undo token that restores the equipment and referencing set", async () => {
    const { profile } = seedActor();
    const created = await createEquipmentAction({
      name: "Doomed Bar",
      weight_kg: 20,
      category: "Barbell",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const equipId = created.equipment.id;

    // A logged set that references the equipment (through an activity).
    const act = db
      .prepare(
        "INSERT INTO activities (date, type, title, profile_id) VALUES ('2026-01-01','strength','Bench',?)"
      )
      .run(profile.id);
    const activityId = Number(act.lastInsertRowid);
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
       VALUES (?, 'Bench Press', 1, 60, 5, ?)`
    ).run(activityId, equipId);

    const deleted = await deleteEquipmentAction(equipId);
    if (!deleted.ok) throw new Error(deleted.error);

    expect(
      getEquipment(profile.id, { includeRetired: true }).map((e) => e.id)
    ).not.toContain(equipId);
    const set = db
      .prepare(
        "SELECT equipment_id FROM exercise_sets WHERE activity_id = ? AND set_number = 1"
      )
      .get(activityId) as { equipment_id: number | null };
    expect(set.equipment_id).toBeNull();
    expect(await undoDelete(deleted.undoId)).toEqual({ ok: true });
    expect(getEquipment(profile.id).map((e) => e.id)).toContain(equipId);
    expect(
      db
        .prepare("SELECT equipment_id FROM exercise_sets WHERE activity_id = ?")
        .get(activityId)
    ).toEqual({ equipment_id: equipId });
  });

  it("Data → Manage keeps the exact removed PR dismissal in its equipment token", async () => {
    const { profile } = seedActor();
    const equipmentId = Number(
      db
        .prepare(
          "INSERT INTO equipment (profile_id, name) VALUES (?, 'Bulk equipment undo')"
        )
        .run(profile.id).lastInsertRowid
    );
    const activityId = Number(
      db
        .prepare(
          "INSERT INTO activities (profile_id, date, type, title) VALUES (?, '2026-08-01', 'strength', 'Bulk undo set')"
        )
        .run(profile.id).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, equipment_id) VALUES (?, 'Machine Chest Press', 1, 60, 5, ?)"
    ).run(activityId, equipmentId);
    const key = prStrengthDismissalKey(
      "Machine Chest Press",
      equipmentId,
      "1rm"
    );
    db.prepare(
      "INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at) VALUES (?, ?, '2026-08-01 12:00:00')"
    ).run(profile.id, key);
    const removed = await deleteDatasetRows("equipment", [equipmentId]);
    if (!removed.ok) throw new Error(removed.error);
    expect(removed.deleted).toBe(1);
    expect(removed.undoIds).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT id FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
        )
        .get(profile.id, key)
    ).toBeUndefined();
    expect(await undoDelete(removed.undoIds[0])).toEqual({ ok: true });
    expect(
      db
        .prepare("SELECT equipment_id FROM exercise_sets WHERE activity_id = ?")
        .get(activityId)
    ).toEqual({ equipment_id: equipmentId });
    expect(
      db
        .prepare(
          "SELECT dismissed_at FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
        )
        .get(profile.id, key)
    ).toEqual({ dismissed_at: "2026-08-01 12:00:00" });
  });

  // #2138: the delete is row-count-checked — a forged id (or a second tap racing
  // the first) reports failure instead of the old unconditional `{ ok: true }`.
  it("a forged-id delete reports failure instead of { ok: true }", async () => {
    seedActor();
    const res = await deleteEquipmentAction(99999);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/find that equipment/);
  });
});
