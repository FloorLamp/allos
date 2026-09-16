// Appointment lifecycle write core (#2134). `appointments.status` is a
// scheduled/completed/cancelled LIFECYCLE flag — the one-tap Mark completed /
// Cancel / Reopen buttons, the palette's "Mark complete", the "Log this visit"
// close-the-loop, and the import path's appointment↔encounter auto-complete all
// transition it. Until #2134 the user-facing taps were a bare `SET status = ?`
// that could not refuse, while the machine-driven import writer compare-and-swapped
// the very same transition; this module makes the CAS discipline the only way in.
//
// Auth-blind: takes profileId first, never imports lib/auth. The Server Action
// authorizes, validates, and revalidates; this module owns the transition and its
// typed refusals, under the #2133 Tx-token helpers so the guard read and the swap
// provably share one IMMEDIATE transaction.

// THE TWO USER-TAP CORES TAKE THE ID A WRITE GATE RETURNED: `profileId` on
// setAppointmentStatus and completeAndLinkEncounterTx is lib/auth's
// WriteAuthorizedProfileId, which only the gates mint, so an action that never gated holds
// nothing they take (#5348). The import is type-only — erased at build — so this module
// still runs auth-blind and app/(app)/encounters/appointment-actions.ts still owns the gate.
// A branded number is still a number, so completeScheduledAndLinkEncounterTx takes one
// unchanged — it is the import path's transition, reached from lib/import-persist, so it has
// no gated caller to take a minted id from.
//
// What the brand buys is stated narrowly on purpose. `tsc` refuses a plain number at a call
// site — the ordinary accident — and eslint.config.mjs's WRITE_BRAND_CAST refuses production
// code the `as WriteAuthorizedProfileId` forge, across every production module (#5852,
// #5864); a test tier is deliberately left free to cast, the same allowance RPE_BRAND_CAST
// makes. Those are the accidents it catches; it does not make the brand unforgeable, and the
// residual is not a list anyone has closed (#5892, #5914). So "calls a branded core" is
// EVIDENCE of a gate, not PROOF of one — lib/__tests__/actions-write-access.test.ts's
// step-aside rests on that reading.

import type { WriteAuthorizedProfileId } from "./auth";
import { db, writeTx, type Tx } from "./db";
import { casUpdate, readForUpdate, type CasOutcome } from "./tx";
import type { AppointmentStatus } from "./types";

// What a status tap actually did. `done` is the transition landing; the three
// `already-*` kinds report the row's CURRENT status when the expectation did not
// hold — the caller maps "already the target state" to an idempotent answer and a
// cross-state conflict (complete a cancelled row) to a refusal. Same guard shape
// as the import path's scheduled-only CAS.
export type AppointmentStatusOutcome =
  | { kind: "done" }
  | { kind: "not-found" }
  | { kind: "already-scheduled" }
  | { kind: "already-completed" }
  | { kind: "already-cancelled" };

// Set the lifecycle status with the expected prior state in the WHERE:
// completing/cancelling expects a scheduled row, reopening expects a closed one.
// A swap that did not land is distinguished under the write lock into
// row-gone vs already-<current status>, so a stale tab's tap answers honestly
// instead of silently rewriting a transition another surface already made.
export function setAppointmentStatus(
  profileId: WriteAuthorizedProfileId,
  id: number,
  to: AppointmentStatus
): AppointmentStatusOutcome {
  return writeTx((tx) => {
    const swap =
      to === "scheduled"
        ? casUpdate(
            tx,
            db.prepare(
              `UPDATE appointments SET status = 'scheduled'
                WHERE id = ? AND profile_id = ?
                  AND status IN ('completed', 'cancelled')`
            ),
            id,
            profileId
          )
        : casUpdate(
            tx,
            db.prepare(
              `UPDATE appointments SET status = ?
                WHERE id = ? AND profile_id = ? AND status = 'scheduled'`
            ),
            to,
            id,
            profileId
          );
    if (swap.kind === "applied") return { kind: "done" };
    const row = readForUpdate<{ status: AppointmentStatus }>(
      tx,
      db.prepare(
        `SELECT status FROM appointments WHERE id = ? AND profile_id = ?`
      ),
      id,
      profileId
    );
    if (!row) return { kind: "not-found" };
    switch (row.status) {
      case "scheduled":
        return { kind: "already-scheduled" };
      case "completed":
        return { kind: "already-completed" };
      case "cancelled":
        return { kind: "already-cancelled" };
    }
  });
}

// "Log this visit" (#288): complete an appointment AND record its encounter
// back-link in one swap, guarded on the link being unclaimed. Deliberately NOT
// status-guarded — the offer renders on a completed-but-unlinked row too, and
// attending the visit is what "completed" means. In-transaction (Tx token): the
// caller inserts the encounter and links it under the same writeTx, so a stale
// tap can never orphan a just-created visit — the caller maps `stale`
// (meanwhile linked, or row gone) to its idempotent/refusal answer.
export function completeAndLinkEncounterTx(
  tx: Tx,
  profileId: WriteAuthorizedProfileId,
  id: number,
  encounterId: number
): CasOutcome {
  return casUpdate(
    tx,
    db.prepare(
      `UPDATE appointments SET status = 'completed', encounter_id = ?
        WHERE id = ? AND profile_id = ? AND encounter_id IS NULL`
    ),
    encounterId,
    id,
    profileId
  );
}

// The import path's transition (#288 auto-complete): only a still-scheduled,
// unlinked appointment may be claimed by a just-imported encounter — a manual
// completion or cancellation is user state the machine must never overwrite
// (the contact-consent rule). `stale` simply skips the candidate.
export function completeScheduledAndLinkEncounterTx(
  tx: Tx,
  profileId: number,
  id: number,
  encounterId: number
): CasOutcome {
  return casUpdate(
    tx,
    db.prepare(
      `UPDATE appointments
          SET status = 'completed', encounter_id = ?
        WHERE id = ? AND profile_id = ? AND status = 'scheduled'
          AND encounter_id IS NULL`
    ),
    encounterId,
    id,
    profileId
  );
}
