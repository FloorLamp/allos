// The stored food-sensitivity declarations (#5865). One `food_sensitivities` row per
// statement the person wrote; the vocabulary and how a row reads are pure and live in
// lib/food-sensitivities.ts.
//
// Auth-blind (profileId-first, never imports lib/auth — #319): the Server Action owns
// the gate and the revalidation. EVERY statement here is profile-scoped, which the leak
// scan holds it to now that `food_sensitivities` is in OWNED_TABLES — including the
// lifecycle flip and the delete, where an unscoped `WHERE id = ?` would let a leaked id
// reach another profile's row.
//
// STOPPING IS NOT DELETING, and the two are separate calls for a reason. `status =
// 'stopped'` keeps the row — the marks already on past meals stay explicable, and the
// person can start counting again without retyping the declaration — while taking the
// chip and the pair away. DELETE is for a declaration that was a mistake; the marks on
// past meals still stay, because they are facts about those meals rather than about
// this row (#5865's invariant).

import { db } from "./db";
import type {
  FoodSensitivity,
  FoodSensitivityTriggerKind,
} from "./food-sensitivities";

const COLS = "id, trigger_kind, trigger_slug, effect, note, status";

export interface FoodSensitivityInput {
  trigger_kind: FoodSensitivityTriggerKind;
  trigger_slug: string;
  effect: string;
  note: string | null;
}

/**
 * Every declaration the profile has made, stopped ones included — the Manage catalog
 * lists both, the way the equipment catalog lists retired gear.
 *
 * Ordered by trigger so the list is stable across edits; a declaration has no time of
 * its own to order by, and inventing one would be a column nothing reads.
 */
export function getFoodSensitivities(profileId: number): FoodSensitivity[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM food_sensitivities
        WHERE profile_id = ?
        ORDER BY status, trigger_slug COLLATE NOCASE, effect`
    )
    .all(profileId) as FoodSensitivity[];
}

/**
 * The declarations that are actually counting — what the food sheet's chip row and the
 * declared pairs are built from (slices 2 and 3).
 */
export function getActiveFoodSensitivities(
  profileId: number
): FoodSensitivity[] {
  return getFoodSensitivities(profileId).filter((s) => s.status === "active");
}

export function getFoodSensitivity(
  profileId: number,
  id: number
): FoodSensitivity | undefined {
  return db
    .prepare(
      `SELECT ${COLS} FROM food_sensitivities WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as FoodSensitivity | undefined;
}

/**
 * Whether this profile has already declared this exact (trigger, effect) pair. The
 * table's UNIQUE index is the backstop; this is what lets the form say so in words
 * instead of failing on a constraint. Pass `exceptId` when editing so a row does not
 * collide with itself.
 */
export function foodSensitivityExists(
  profileId: number,
  input: FoodSensitivityInput,
  exceptId?: number
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM food_sensitivities
        WHERE profile_id = ? AND trigger_kind = ? AND trigger_slug = ?
          AND effect = ? AND id IS NOT ?`
    )
    .get(
      profileId,
      input.trigger_kind,
      input.trigger_slug,
      input.effect,
      exceptId ?? null
    );
  return row != null;
}

export function createFoodSensitivity(
  profileId: number,
  input: FoodSensitivityInput
): FoodSensitivity {
  const info = db
    .prepare(
      `INSERT INTO food_sensitivities
         (profile_id, trigger_kind, trigger_slug, effect, note)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      profileId,
      input.trigger_kind,
      input.trigger_slug,
      input.effect,
      input.note
    );
  return getFoodSensitivity(profileId, Number(info.lastInsertRowid))!;
}

/** True when a row was actually updated — a stale id changes nothing and says so. */
export function updateFoodSensitivity(
  profileId: number,
  id: number,
  input: FoodSensitivityInput
): boolean {
  const info = db
    .prepare(
      `UPDATE food_sensitivities
          SET trigger_kind = ?, trigger_slug = ?, effect = ?, note = ?
        WHERE id = ? AND profile_id = ?`
    )
    .run(
      input.trigger_kind,
      input.trigger_slug,
      input.effect,
      input.note,
      id,
      profileId
    );
  return info.changes > 0;
}

/**
 * Stop or resume counting. A state-named swap (#2138): the caller posts the state its
 * render promised and the WHERE carries the inverse, so a flip that did not land is a
 * false return rather than a success the UI invents.
 */
export function setFoodSensitivityStatus(
  profileId: number,
  id: number,
  status: "active" | "stopped"
): boolean {
  const info = db
    .prepare(
      `UPDATE food_sensitivities SET status = ?
        WHERE id = ? AND profile_id = ? AND status = ?`
    )
    .run(status, id, profileId, status === "active" ? "stopped" : "active");
  return info.changes > 0;
}

export function deleteFoodSensitivity(profileId: number, id: number): boolean {
  const info = db
    .prepare(`DELETE FROM food_sensitivities WHERE id = ? AND profile_id = ?`)
    .run(id, profileId);
  return info.changes > 0;
}
