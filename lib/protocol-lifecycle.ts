// Protocol lifecycle write core (#2135). `protocols.end_date` is a THREE-state machine
// — ongoing (NULL), recently ended and therefore resumable, ended long enough ago that
// the honest move is a new run — and the states are already named, once, in the pure
// `protocolReopenEligibility` (lib/protocol-reopen.ts). What was missing was the write
// half: end and resume read the row with `getProtocol` OUTSIDE the transaction they
// then wrote in, guarded with a bare `id = ? AND profile_id = ?` UPDATE that could not
// refuse, and answered in English `formError` strings rather than typed outcomes.
//
// Its structural twin is `cycles` (lib/cycle-write.ts): an open/closed row with a
// bounded reopen window and an expired tail, whose transitions are one writeTx each,
// every refusal typed and enforced with the SAME pure predicate the surface renders
// from. This module is that shape for protocols.
//
// Auth-blind: profileId first, never imports lib/auth. The Server Action authorizes,
// validates and revalidates; this module owns the transition, its refusals, and the
// SITUATION inversion that has to land with it — a protocol that reads "ended" while
// its situation is still active keeps firing situational supplements and nudges for a
// block the user has stopped, and the converse strands a resumed protocol with its
// supplements off. One writeTx, both halves, under the #2133 Tx-token helpers so the
// guard read and the swap provably share one IMMEDIATE transaction.

import { db, writeTx, type Tx } from "./db";
import { casUpdate, readForUpdate } from "./tx";
import { getActiveSituations, setActiveSituations } from "./settings";
import { situationUsedByOtherProtocol } from "./queries/protocols";
import {
  protocolReopenEligibility,
  type ProtocolReopenEligibility,
} from "./protocol-reopen";

// The row facts a transition needs. Read inside the transaction, never handed in.
interface ProtocolState {
  end_date: string | null;
  situation: string | null;
}

function protocolStateForUpdate(
  tx: Tx,
  profileId: number,
  id: number
): ProtocolState | undefined {
  return readForUpdate<ProtocolState>(
    tx,
    db.prepare(
      `SELECT end_date, situation FROM protocols WHERE id = ? AND profile_id = ?`
    ),
    id,
    profileId
  );
}

// Add a situation label to the profile's active set (idempotent), reusing the existing
// situations wiring so a started protocol surfaces its situational supplements exactly
// like a manual toggle. Lives here rather than in the Server Action module because
// every protocol transition that touches the active set — create, edit, end, resume,
// delete — must invert it the same way.
export function activateSituation(profileId: number, situation: string) {
  const next = new Set(getActiveSituations(profileId));
  next.add(situation);
  setActiveSituations(profileId, [...next]);
}

// Remove a situation label from the active set UNLESS another still-ongoing protocol
// declares it (row-side-state rule: a protocol's end/delete inverts the activation it
// caused, but must not clobber a situation a sibling protocol needs).
export function deactivateSituation(
  profileId: number,
  situation: string,
  exceptProtocolId: number
) {
  if (situationUsedByOtherProtocol(profileId, situation, exceptProtocolId))
    return;
  const next = new Set(getActiveSituations(profileId));
  if (next.delete(situation)) setActiveSituations(profileId, [...next]);
}

export type EndProtocolOutcome =
  | { kind: "ended"; endDate: string }
  | { kind: "not-found" }
  // The row was already closed when the write lock was taken — a stale tab, a double
  // tap, or a sibling surface that ended it first. Reported, never re-ended: rewriting
  // `end_date` would move the comparison window the results are computed over.
  | { kind: "already-ended"; endDate: string };

// End an ongoing protocol as of `endDate` (the profile's today; the bound is
// INCLUSIVE, #2232's convention). The CAS expects `end_date IS NULL`, so two taps
// racing produce one `ended` and one honest `already-ended`.
export function endProtocolCore(
  profileId: number,
  id: number,
  endDate: string
): EndProtocolOutcome {
  return writeTx((tx) => {
    const swap = casUpdate(
      tx,
      db.prepare(
        `UPDATE protocols SET end_date = ?
          WHERE id = ? AND profile_id = ? AND end_date IS NULL`
      ),
      endDate,
      id,
      profileId
    );
    const row = protocolStateForUpdate(tx, profileId, id);
    if (!row) return { kind: "not-found" };
    if (swap.kind === "stale")
      return { kind: "already-ended", endDate: row.end_date! };
    // Ending the protocol inverts its situation activation, in THIS transaction.
    if (row.situation) deactivateSituation(profileId, row.situation, id);
    return { kind: "ended", endDate };
  });
}

export type ResumeProtocolOutcome =
  | { kind: "resumed" }
  | { kind: "not-found" }
  // Already ongoing — nothing to resume. A stale page can reach this.
  | { kind: "already-ongoing" }
  // Ended longer ago than the reopen window: resuming would silently fold a finished
  // comparison window into a new one, so the honest move is a fresh run.
  | { kind: "expired" }
  // The stored end date is not a real ISO day, or is in the future relative to `asOf`.
  // Nothing sane to compare against, so nothing is written.
  | { kind: "invalid" };

// Reopen a recently ended protocol. The eligibility question is asked with the SAME
// pure function the Resume control renders from, on the row read under the write lock,
// and the CAS expects that exact end date — so a protocol resumed (or re-ended) by
// another tab between render and tap refuses instead of reopening the wrong run.
export function resumeProtocolCore(
  profileId: number,
  id: number,
  asOf: string
): ResumeProtocolOutcome {
  return writeTx((tx) => {
    const row = protocolStateForUpdate(tx, profileId, id);
    if (!row) return { kind: "not-found" };
    const eligibility = protocolReopenEligibility(row.end_date, asOf);
    if (eligibility.kind !== "eligible") return refusalFor(eligibility);
    const swap = casUpdate(
      tx,
      db.prepare(
        `UPDATE protocols SET end_date = NULL
          WHERE id = ? AND profile_id = ? AND end_date = ?`
      ),
      id,
      profileId,
      row.end_date
    );
    // The read above shares this transaction, so the expectation cannot have moved;
    // `stale` here would mean the row vanished mid-transaction.
    if (swap.kind === "stale") return { kind: "not-found" };
    if (row.situation) activateSituation(profileId, row.situation);
    return { kind: "resumed" };
  });
}

// The pure machine's non-eligible states, in this core's refusal vocabulary. One
// mapping, so a caller never re-reads `protocolReopenEligibility` to name a refusal.
function refusalFor(
  eligibility: ProtocolReopenEligibility
): ResumeProtocolOutcome {
  switch (eligibility.kind) {
    case "ongoing":
      return { kind: "already-ongoing" };
    case "expired":
      return { kind: "expired" };
    default:
      return { kind: "invalid" };
  }
}
