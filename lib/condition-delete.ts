// The shared inbound-link detach for a literal condition delete (#3648).
//
// A condition can be named by two intake-item facts: the medication's singular
// indication and any item's structured condition-purpose rows. Neither reference has
// an ON DELETE action. Call this inside the SAME writeTx as the condition DELETE so
// links cannot be cleared without the condition delete landing.
//
// Both mutations are scoped to the condition's owner AND the intake item's owner.
// Therefore a corrupt cross-profile link is deliberately left in place: SQLite's FK
// rejects the condition delete and the surrounding transaction rolls back instead of
// authorizing a mutation to the other profile.

import { db } from "./db";

export function detachConditionIntakeLinks(
  profileId: number,
  conditionId: number
): void {
  db.prepare(
    `UPDATE intake_items
        SET indication_condition_id = NULL
      WHERE profile_id = ?
        AND indication_condition_id IN (
          SELECT id FROM conditions WHERE id = ? AND profile_id = ?
        )`
  ).run(profileId, conditionId, profileId);

  // Removed rather than nulled: a condition purpose without its condition is not a
  // purpose, and intake_item_purposes' CHECK makes that invalid. Other purpose kinds
  // and condition purposes naming a different condition are untouched.
  db.prepare(
    `DELETE FROM intake_item_purposes
      WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)
        AND condition_id IN (
          SELECT id FROM conditions WHERE id = ? AND profile_id = ?
        )`
  ).run(profileId, conditionId, profileId);
}
