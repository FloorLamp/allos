// The auth-blind write core behind Pause/Resume on an intake item (#2133). Takes
// `profileId` first and never imports lib/auth — the Server Action performs
// authorization, validation and revalidation.
//
// `active` is the pause LIFECYCLE flag, not a form field, so the write is a STATE-NAMED
// transition on the demoteIntakeObligation shape: the caller posts the state its render
// promised (`to`), the compare runs inside one IMMEDIATE transaction via the Tx-token
// helpers, and a mismatch refuses — a stale tab's "Pause" on an item someone else
// already paused must report "already paused" rather than silently RESUMING it and
// toasting the wrong words (the read-then-flip inversion this core replaces).
//
// A medication's pause also closes/opens its course history (the active=1 ⇔ open-course
// invariant), so that branch delegates to the course core's setMedicationActive
// (lib/queries/intake/medications.ts), which returns this same outcome vocabulary. The
// nested writeTx is a SAVEPOINT (#468), so the delegation commits or refuses as one.

import { db, today, writeTx } from "./db";
import { casUpdate, readForUpdate } from "./tx";
import { setMedicationActive } from "./queries/intake/medications";

export type IntakeActiveOutcome =
  "paused" | "resumed" | "already-paused" | "already-active" | "not-found";

// What the caller renders per refusal — one vocabulary so the web toast and any future
// surface say the same thing (#221).
export const INTAKE_ACTIVE_REFUSAL_TEXT: Record<
  Exclude<IntakeActiveOutcome, "paused" | "resumed">,
  string
> = {
  "not-found": "Couldn't find that item.",
  "already-paused": "Already paused — nothing changed.",
  "already-active": "Already active — nothing changed.",
};

export function setIntakeActive(
  profileId: number,
  itemId: number,
  to: 0 | 1
): IntakeActiveOutcome {
  return writeTx((tx): IntakeActiveOutcome => {
    const row = readForUpdate<{ active: number; kind: string }>(
      tx,
      db.prepare(
        "SELECT active, kind FROM intake_items WHERE id = ? AND profile_id = ?"
      ),
      itemId,
      profileId
    );
    if (!row) return "not-found";
    if (row.active === to) {
      return to === 1 ? "already-active" : "already-paused";
    }
    if (row.kind === "medication") {
      // Course-history sync lives with the course core; same outcome words.
      return setMedicationActive(profileId, itemId, to, today(profileId));
    }
    const res = casUpdate(
      tx,
      db.prepare(
        "UPDATE intake_items SET active = ? WHERE id = ? AND profile_id = ? AND active = ?"
      ),
      to,
      itemId,
      profileId,
      to === 1 ? 0 : 1
    );
    if (res.kind === "stale") {
      // Unreachable inside the transaction after the guard read; kept so a write that
      // did not land can never be reported as a transition.
      return to === 1 ? "already-active" : "already-paused";
    }
    return to === 1 ? "resumed" : "paused";
  });
}
