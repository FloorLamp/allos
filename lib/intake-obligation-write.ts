// The auth-blind write core behind accepting an obligation DEMOTION SUGGESTION
// (issue #1505 part 2). Takes `profileId` first and never imports lib/auth — the
// Server Action performs authorization, validation and revalidation.
//
// This is the ONLY code path #1505 adds that lowers an `obligation`, and it runs only
// from a user's explicit tap: the detector suggests, the person decides (#559 —
// obligation is declared, never inferred). It is also the only reason the write is
// modelled as a compare-and-swap rather than a plain UPDATE: "demote this" is a
// LIFECYCLE transition off a specific starting state, so a second tap (a double
// submit, a stale card in another tab, a second caregiver's device) must report
// "already low" rather than silently re-confirming a change it did not make.

import { db, writeTx } from "./db";
import type { DemotionOutcome } from "./supplement-demotion";

// Set an intake item's obligation to `may`, reporting what actually happened. The
// read + write run inside one IMMEDIATE transaction so the check can't race a
// concurrent edit from the web replica or the notify sidecar.
//
// Refusals are deliberate and each is rendered by the caller:
//   not-found  — no such item for THIS profile (a stale card, a deleted item, or a
//                cross-profile id; the profile filter is the authorization backstop
//                behind the action's own access check).
//   inactive   — the item is paused/stopped. A paused item's priority is left alone:
//                the user may be mid-decision about the item itself, and a pause is
//                not a lapse (the detector excludes paused items for the same reason).
//   already-may — nothing to do; the suggestion has already been accepted.
export function demoteIntakeObligation(
  profileId: number,
  itemId: number
): DemotionOutcome {
  return writeTx((): DemotionOutcome => {
    const row = db
      .prepare(
        `SELECT obligation, active FROM intake_items
          WHERE id = ? AND profile_id = ?`
      )
      .get(itemId, profileId) as
      { obligation: string; active: number } | undefined;
    if (!row) return "not-found";
    if (!row.active) return "inactive";
    if (row.obligation === "may") return "already-may";
    // Compare-and-swap on the starting obligation: the UPDATE only lands while the row
    // still holds the value the check read, so two concurrent accepts produce exactly
    // one "demoted" and one honest "already-may".
    const res = db
      .prepare(
        `UPDATE intake_items SET obligation = 'may'
          WHERE id = ? AND profile_id = ? AND obligation = ? AND active = 1`
      )
      .run(itemId, profileId, row.obligation);
    return res.changes === 1 ? "demoted" : "already-may";
  });
}
