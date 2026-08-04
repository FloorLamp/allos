import { db, writeTx } from "./db";
import type { Equipment } from "./types";
import {
  summarizeEquipmentAvailability,
  type EquipmentAvailability,
} from "./equipment-availability";
import { cleanupOrphanPrDismissals } from "./queries/upcoming/suppressions";

// Shape accepted from the manager UI. Weight is in kg (callers convert from the
// user's display unit first).
export interface EquipmentInput {
  name: string;
  weight_kg: number | null;
  category: string | null;
}

// Equipment is per-profile: deleteEquipment() nulls
// exercise_sets.equipment_id, so a shared row would let one profile's cleanup
// corrupt another's set history.
//
// By default RETIRED rows are excluded — the common caller is a picker or
// recency-defaulting, which must not offer sold/broken gear (issue #341, mirroring
// getSupplementDoses excluding retired doses). Callers that need every row —
// the settings manager (to Unretire) and history label maps (retired gear still
// labels old sets) — pass { includeRetired: true }.
export function getEquipment(
  profileId: number,
  opts?: { includeRetired?: boolean }
): Equipment[] {
  const where = opts?.includeRetired ? "" : " AND retired = 0";
  return db
    .prepare(
      `SELECT * FROM equipment WHERE profile_id = ?${where} ORDER BY name COLLATE NOCASE`
    )
    .all(profileId) as Equipment[];
}

// The profile's equipment availability summary (issue #345): "has barbell?
// dumbbells? machine? bike?" from its NON-retired rows, for gating workout /
// exercise suggestions. The ONE read every consumer formats over; pure logic lives
// in summarizeEquipmentAvailability so it stays unit-tested and client-safe.
export function availableEquipmentKinds(
  profileId: number
): EquipmentAvailability {
  return summarizeEquipmentAvailability(getEquipment(profileId));
}

export function getEquipmentById(
  profileId: number,
  id: number
): Equipment | undefined {
  return db
    .prepare("SELECT * FROM equipment WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as Equipment | undefined;
}

// True if another equipment row already uses this name (case-insensitive) within
// this profile. Pass `exceptId` when editing so a row doesn't collide with
// itself. Equipment is matched by name in the importer, so duplicate names would
// silently collapse.
export function equipmentNameExists(
  profileId: number,
  name: string,
  exceptId?: number
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM equipment
        WHERE profile_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?`
    )
    .get(profileId, name.trim(), exceptId ?? null);
  return row != null;
}

export function createEquipment(
  profileId: number,
  input: EquipmentInput
): Equipment {
  const info = db
    .prepare(
      `INSERT INTO equipment (profile_id, name, weight_kg, category)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      profileId,
      input.name.trim(),
      input.weight_kg,
      input.category?.trim() || null
    );
  return getEquipmentById(profileId, Number(info.lastInsertRowid))!;
}

export function updateEquipment(
  profileId: number,
  id: number,
  input: EquipmentInput
): void {
  db.prepare(
    `UPDATE equipment
       SET name = ?, weight_kg = ?, category = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    input.name.trim(),
    input.weight_kg,
    input.category?.trim() || null,
    id,
    profileId
  );
}

// Soft-retire (or un-retire) an equipment row — the reversible alternative to
// delete (issue #341). A retired row drops out of pickers/recency-defaulting but
// keeps its id, so historical sets that reference it still resolve their implement
// label. Scoped to the profile so a leaked id can't reach another profile's rows.
export function setEquipmentRetired(
  profileId: number,
  id: number,
  retired: boolean
): void {
  db.prepare(
    `UPDATE equipment SET retired = ? WHERE id = ? AND profile_id = ?`
  ).run(retired ? 1 : 0, id, profileId);
}

// Delete an equipment row, first detaching it from any row that links to it so
// their history survives (the columns have no FK ON DELETE action, so this is done
// in code — #342 added the activity link, #344 the protocol reference). Equipment
// is gear at FOUR places: the per-set strength implement
// (exercise_sets.equipment_id), the session-level activity link
// (activities.equipment_id), a protocol's recovery-gear reference
// (protocols.equipment_id), and a goal's optional load context
// (goals.equipment_id, #1610). Every detach and the delete are scoped to the profile
// so a leaked id can't reach another profile's rows.
//
// A goal detaches back to MOVEMENT-WIDE, which is the honest reading: the machine it
// was scoped to no longer exists, and #1610's compatibility clause says a destructive
// delete must not have provenance invented for it. Its sets have moved to the
// unassigned lane in the same transaction, so a goal left pointing at the dead id
// would measure nothing at all.
export function deleteEquipment(profileId: number, id: number): void {
  writeTx(() => {
    db.prepare(
      `UPDATE exercise_sets SET equipment_id = NULL
        WHERE equipment_id = ?
          AND activity_id IN (SELECT id FROM activities WHERE profile_id = ?)`
    ).run(id, profileId);
    db.prepare(
      `UPDATE activities SET equipment_id = NULL
        WHERE equipment_id = ? AND profile_id = ?`
    ).run(id, profileId);
    db.prepare(
      `UPDATE protocols SET equipment_id = NULL
        WHERE equipment_id = ? AND profile_id = ?`
    ).run(id, profileId);
    db.prepare(
      `UPDATE goals SET equipment_id = NULL
        WHERE equipment_id = ? AND profile_id = ?`
    ).run(id, profileId);
    db.prepare("DELETE FROM equipment WHERE id = ? AND profile_id = ?").run(
      id,
      profileId
    );
  });
  // Moving every set off this implement retires its LOAD LANE, and a personal-record
  // celebration's dismissal is keyed on (movement, lane) — so the deleted id's `pr:`
  // suppression rows now point at a lane no set is in (#1931). This is the row-ops
  // rule's "saved/dismissed side-state" clause: a delete must carry its dismissals
  // too, or a lane id SQLite later reissues inherits the old machine's silence.
  // Outside the transaction (like the other sweeps) so it reads the committed state.
  cleanupOrphanPrDismissals(profileId);
}
