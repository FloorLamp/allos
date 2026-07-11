// DB INTEGRATION TIER — the ACTIVITY-level equipment link (issue #342).
//
// Proves the migration-019 column exists with a real (enforced) FK, that
// deleteEquipment nulls the new activities link the same way it nulls the set link,
// that a deleted activity round-trips through undo (nulling the gear link if the
// equipment died meanwhile), and that getLastActivityEquipmentByType reads the most
// recent per-type gear used to default the picker.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { deleteEquipment } from "@/lib/equipment";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";
import { getLastActivityEquipmentByType } from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
let bikeId: number;
let shoesId: number;

beforeAll(() => {
  p = seedProfile("ACTEQUIP");
  bikeId = Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Road Bike', 'Bike')`
      )
      .run(p.profileId).lastInsertRowid
  );
  shoesId = Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Trail Shoes', 'Shoes')`
      )
      .run(p.profileId).lastInsertRowid
  );
});

const equipmentOf = (activityId: number) =>
  (
    db
      .prepare("SELECT equipment_id FROM activities WHERE id = ?")
      .get(activityId) as { equipment_id: number | null }
  ).equipment_id;

describe("migration 019 — activities.equipment_id", () => {
  it("adds a nullable equipment_id column to activities", () => {
    const cols = (
      db.prepare("PRAGMA table_info(activities)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("equipment_id");
  });

  it("carries a real, enforced FK to equipment(id)", () => {
    // A valid link is accepted...
    db.prepare("UPDATE activities SET equipment_id = ? WHERE id = ?").run(
      bikeId,
      p.cardioActivityId
    );
    expect(equipmentOf(p.cardioActivityId)).toBe(bikeId);
    // ...a dangling one is rejected by the FK (foreign_keys = ON).
    expect(() =>
      db
        .prepare("UPDATE activities SET equipment_id = 999999 WHERE id = ?")
        .run(p.cardioActivityId)
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("deleteEquipment nulls the activity link (#342 row-ops)", () => {
  it("detaches a deleted equipment from any activity that referenced it", () => {
    db.prepare("UPDATE activities SET equipment_id = ? WHERE id = ?").run(
      shoesId,
      p.cardioActivityId
    );
    expect(equipmentOf(p.cardioActivityId)).toBe(shoesId);
    deleteEquipment(p.profileId, shoesId);
    expect(equipmentOf(p.cardioActivityId)).toBeNull();
    // The equipment row itself is gone.
    expect(
      db.prepare("SELECT id FROM equipment WHERE id = ?").get(shoesId)
    ).toBeUndefined();
  });
});

describe("undo restore reconciles a dangling gear link (#342 / #202)", () => {
  it("restores an activity, nulling equipment_id when the gear was deleted meanwhile", () => {
    // Link the cardio activity to the bike, then capture-delete the activity.
    db.prepare("UPDATE activities SET equipment_id = ? WHERE id = ?").run(
      bikeId,
      p.cardioActivityId
    );
    const undoId = captureDelete("activity", p.profileId, p.cardioActivityId);
    expect(undoId).not.toBeNull();
    // The bike is deleted before the undo runs — its id now dangles in the payload.
    deleteEquipment(p.profileId, bikeId);

    expect(restoreDeletedRow(p.profileId, undoId!)).toBe(true);
    // The activity is back (a NEW id), and its now-dangling gear link was nulled
    // rather than aborting the whole restore with an FK violation.
    const restored = db
      .prepare(
        "SELECT id, equipment_id FROM activities WHERE profile_id = ? AND type = 'cardio' ORDER BY id DESC LIMIT 1"
      )
      .get(p.profileId) as { id: number; equipment_id: number | null };
    expect(restored.equipment_id).toBeNull();
  });
});

describe("getLastActivityEquipmentByType", () => {
  it("returns the most recent gear id per activity type, profile-scoped", () => {
    const other = seedProfile("ACTEQUIP2");
    const rowerId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Rower', 'Bike')`
        )
        .run(other.profileId).lastInsertRowid
    );
    // Two cardio activities; the newer one (later id) wins.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, equipment_id)
       VALUES (?, '2026-01-01', 'cardio', 'Old ride', ?)`
    ).run(other.profileId, rowerId);
    const newerId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, equipment_id)
           VALUES (?, '2026-06-01', 'cardio', 'New ride', ?)`
        )
        .run(other.profileId, rowerId).lastInsertRowid
    );
    expect(newerId).toBeGreaterThan(0);

    const map = getLastActivityEquipmentByType(other.profileId);
    expect(map.cardio).toBe(rowerId);
    // No sport gear linked → absent.
    expect(map.sport).toBeUndefined();
    // Isolation: the other profile's map doesn't see this profile's gear.
    expect(getLastActivityEquipmentByType(p.profileId).cardio).not.toBe(
      rowerId
    );
  });
});
