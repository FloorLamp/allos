// THE one way a frequency_targets row is removed (issue #1809).
//
// `protocols.frequency_target_id` is a REFERENCES FK with NO ON DELETE action, so every
// delete of a target must first free any protocol that adopted it as its adherence
// intervention — otherwise SQLite refuses the delete and the caller throws a bare
// SQLITE_CONSTRAINT_FOREIGNKEY at the user. That pair (unlink, then delete, in ONE
// IMMEDIATE transaction so it cannot half-apply and strand a protocol pointing at a
// deleted target) had been written out inline at five call sites and forgotten at three
// more; this is the sixth-and-only copy.
//
// THE DEGRADATION IS THE PRODUCT DECISION, and it is not new here: a protocol whose
// target is deleted becomes a protocol with no adherence intervention — the honest state,
// already chosen by the substance-use, food-habit, wellness-practice and right-sizing
// paths. `owns_frequency_target` is cleared alongside the link because ownership of a
// row that no longer exists is not a thing a protocol can hold.
//
// Auth-blind by the lib/ contract: `profileId` comes first, nothing here imports
// lib/auth, and every statement is profile-scoped. The Server Action does the
// authorization.

import { db, writeTx } from "./db";

// Free every protocol link to these targets. Exposed separately for the BULK deletes
// (routine activation replaces a profile's whole training-scope target set), which
// delete by predicate rather than by id.
export function unlinkProtocolsFromTargets(
  profileId: number,
  targetIds: readonly number[]
): void {
  if (targetIds.length === 0) return;
  const holes = targetIds.map(() => "?").join(", ");
  db.prepare(
    `UPDATE protocols SET frequency_target_id = NULL, owns_frequency_target = 0
      WHERE profile_id = ? AND frequency_target_id IN (${holes})`
  ).run(profileId, ...targetIds);
}

// Remove one target row, freeing any protocol that referenced it first. Returns whether
// a row was actually removed (false for an id that is not this profile's, or already
// gone) — callers that report an outcome read it rather than confirming unconditionally.
export function deleteFrequencyTargetRow(
  profileId: number,
  targetId: number
): boolean {
  return writeTx(() => {
    unlinkProtocolsFromTargets(profileId, [targetId]);
    return (
      db
        .prepare(
          `DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?`
        )
        .run(targetId, profileId).changes > 0
    );
  });
}
