import { db, writeTx } from "./db";
import { casUpdate, readForUpdate } from "./tx";
import type { Equipment } from "./types";
import {
  summarizeEquipmentAvailability,
  type EquipmentAvailability,
} from "./equipment-availability";
import { captureDelete } from "./undo-delete-db";

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
// getIntakeDoses excluding retired doses). Callers that need every row —
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
//
// `retired` is a LIFECYCLE flag gating pickers, availability, and suggestions, so
// the flip is a state-named CAS with typed outcomes (#2138, the #2133 mechanism):
// the caller posts the state its render promised, the WHERE carries the inverse as
// its expectation, and a swap that did not land is distinguished — under the same
// write lock — into "already in that state" (a stale tab's repeat tap) versus "row
// gone" (deleted elsewhere). A silent no-op here used to keep offering sold gear.
export type EquipmentRetireOutcome =
  { kind: "applied" } | { kind: "already" } | { kind: "not-found" };

export function setEquipmentRetired(
  profileId: number,
  id: number,
  retired: boolean
): EquipmentRetireOutcome {
  return writeTx((tx) => {
    const swap = casUpdate(
      tx,
      db.prepare(
        `UPDATE equipment SET retired = ?
          WHERE id = ? AND profile_id = ? AND retired = ?`
      ),
      retired ? 1 : 0,
      id,
      profileId,
      retired ? 0 : 1
    );
    if (swap.kind === "applied") return { kind: "applied" as const };
    const row = readForUpdate<{ id: number }>(
      tx,
      db.prepare(`SELECT id FROM equipment WHERE id = ? AND profile_id = ?`),
      id,
      profileId
    );
    return row ? { kind: "already" as const } : { kind: "not-found" as const };
  });
}

// Equipment undo preserves the implement's load-lane identity and reconnects
// captured links that still stand unassigned. The registry owns detachment and
// PR dismissal capture for both this action and Data → Manage.
export type EquipmentDeleteOutcome =
  { kind: "deleted"; undoId: number } | { kind: "not-found" };

export function deleteEquipment(
  profileId: number,
  id: number
): EquipmentDeleteOutcome {
  const undoId = captureDelete("equipment", profileId, id);
  return undoId === null ? { kind: "not-found" } : { kind: "deleted", undoId };
}
