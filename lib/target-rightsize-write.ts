// The two RIGHT-SIZING writes (issue #1670) — the only things that ever change a
// frequency target because of a right-size suggestion, and both of them run ONLY from
// a user's tap. Auth-blind by the lib/ contract: `profileId` comes first and nothing
// here imports lib/auth; the Server Action does the authorization.
//
// Both are DOWNWARD and both are IDEMPOTENT-BY-REFUSAL rather than idempotent-by-
// silence: a stale card tapped twice, or the same suggestion accepted from a second
// device, answers with a typed outcome the surface renders. Nothing here confirms
// success unconditionally.
//
// Neither write touches history. Lowering a floor edits one integer on the target row;
// stopping a target removes the row and leaves every logged session, day and serving
// exactly where it was. That promise is what the suggestion copy makes, so it is
// asserted directly in lib/__db_tests__/target-rightsize.test.ts.

import { db, writeTx } from "./db";
import { untrackWellnessPractice } from "./practice-store";
import type { FrequencyScopeKind } from "./types";
import type { RightSizeOutcome } from "./target-rightsize";

interface TargetRow {
  id: number;
  scope_kind: FrequencyScopeKind;
  per_week: number;
}

function readTarget(
  profileId: number,
  targetId: number
): TargetRow | undefined {
  return db
    .prepare(
      `SELECT id, scope_kind, per_week FROM frequency_targets
        WHERE id = ? AND profile_id = ?`
    )
    .get(targetId, profileId) as TargetRow | undefined;
}

// Lower a target's weekly FLOOR to `newFloor`. Refuses anything that is not a strict
// reduction to a positive integer — the downward-only rule is enforced at the write,
// not merely at the detector, so no future caller can turn this into a promotion path.
// Compare-and-swap on `per_week` (the counter-like-field rule): two concurrent accepts
// leave the lower of the two, never a resurrected higher floor.
export function lowerFrequencyTargetFloor(
  profileId: number,
  targetId: number,
  newFloor: number
): RightSizeOutcome {
  if (!Number.isInteger(newFloor) || newFloor < 1) return "already-lower";
  return writeTx(() => {
    const target = readTarget(profileId, targetId);
    if (!target) return "not-found";
    if (target.per_week <= newFloor) return "already-lower";
    db.prepare(
      `UPDATE frequency_targets SET per_week = ?
        WHERE id = ? AND profile_id = ? AND per_week > ?`
    ).run(newFloor, targetId, profileId, newFloor);
    return "lowered";
  });
}

// Stop tracking a target — the accept that lands in the domain's own no-expectation
// state: a logs-only practice (#1621), an untracked weekly routine, an untracked food
// habit. In every case the ledger survives and the commitment does not.
//
// A practice routes through the practice store's own untrack core rather than a second
// DELETE, so the practice-specific side-state it owns (its Upcoming dismissal row)
// keeps being cleaned up in one place. Every other scope nulls any protocol's link
// FIRST — a live `protocols.frequency_target_id` FK would otherwise block the delete —
// then removes the row, both inside one IMMEDIATE transaction so the pair cannot
// half-apply and strand a protocol pointing at a deleted target.
export function stopTrackingFrequencyTarget(
  profileId: number,
  targetId: number
): RightSizeOutcome {
  const target = readTarget(profileId, targetId);
  if (!target) return "not-found";
  if (target.scope_kind === "practice") {
    const outcome = untrackWellnessPractice(profileId, targetId);
    return outcome.kind === "untracked" ? "stopped" : "not-found";
  }
  return writeTx(() => {
    const live = readTarget(profileId, targetId);
    if (!live) return "not-found";
    db.prepare(
      `UPDATE protocols SET frequency_target_id = NULL, owns_frequency_target = 0
        WHERE profile_id = ? AND frequency_target_id = ?`
    ).run(profileId, targetId);
    db.prepare(
      `DELETE FROM frequency_targets WHERE id = ? AND profile_id = ?`
    ).run(targetId, profileId);
    return "stopped";
  });
}
