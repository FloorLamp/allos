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
import { seedActor } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

describe("createEquipmentAction", () => {
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
});

describe("deleteEquipmentAction", () => {
  it("removes the row and nulls the referencing exercise_sets link", async () => {
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

    await deleteEquipmentAction(equipId);

    expect(
      getEquipment(profile.id, { includeRetired: true }).map((e) => e.id)
    ).not.toContain(equipId);
    const set = db
      .prepare(
        "SELECT equipment_id FROM exercise_sets WHERE activity_id = ? AND set_number = 1"
      )
      .get(activityId) as { equipment_id: number | null };
    expect(set.equipment_id).toBeNull();
  });
});
