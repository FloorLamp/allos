// THE durable post-workout dispatch claim (issue #3058) — the database half of
// "one post-workout contact per session".
//
// ── WHY THE MARKER ALONE WAS NOT ENOUGH ──────────────────────────────────────
//
// The one-shot marker (notify_last_post_workout_<activityId>) is stamped only
// AFTER a successful delivery — deliberately, so a failed send is re-delivered
// by the tick backstop. Between the marker read and the marker stamp sit a
// message build and a network round trip, and two callers can both pass the
// read before either stamps: another PROCESS (a web-process action timer and
// the notify tick), or the same process calling the shared core directly while
// a queued run is mid-send. #3021's per-profile promise chain serializes only
// what goes through the queue; the owner ruling (2026-08-18) makes the property
// database-enforced, with the queue demoted to a latency/order optimization.
//
// ── THE MECHANISM ────────────────────────────────────────────────────────────
//
// One row per announcement identity — the ACTIVITY ID, the exact key the marker
// uses (different activity ids that represent one session remain the #2570
// duplicate-cluster check's responsibility; claiming neither weakens nor
// replaces it). The PRIMARY KEY (profile_id, activity_id) is the election:
// exactly one caller's `pending` INSERT succeeds, across processes and database
// connections, and everyone else returns a typed outcome without dispatching.
//
//   pending — a winner is (or was) on the network. A live pending claim refuses
//             every other caller; a STALE one (older than the lease) is a crash
//             artifact and is taken over by the next caller.
//   sent    — some channel accepted the message. Final: never leased away,
//             never released, survives process restart. The same transaction
//             that writes it stamps the marker (workout-presence.ts).
//
// A TOTAL delivery failure releases the claim (the row is deleted), so the
// existing retry band — the hourly tick backstop re-running the core — finds no
// claim and elects a fresh winner.
//
// ── THE LEASE ────────────────────────────────────────────────────────────────
//
// A winner that crashes after claiming leaves a `pending` row nothing will ever
// finalize or release. `claimed_at` bounds that: a pending claim older than
// POST_WORKOUT_CLAIM_LEASE_MS is retryable (taken over in the same immediate
// transaction that judged it). The lease is derived STRICTLY ABOVE the queue's
// whole-task guard, which itself sits strictly above the #3057 shared dispatch
// deadline — so a lawful winner still waiting on a bounded dispatch can never
// be leased away mid-send; only a run past every deadline it could legally be
// inside loses its claim. The chain is asserted in
// lib/__db_tests__/post-workout-claim.test.ts.
//
// ── WHAT THIS DOES NOT CLAIM (the at-least-once boundary) ────────────────────
//
// Telegram, push, email, and Home Assistant share no transactional idempotency
// key with this database. A winner that crashes AFTER a provider accepted the
// message but BEFORE the `sent` transaction commits leaves a pending claim that
// a post-lease retry will dispatch again — a duplicate contact. That window is
// the documented at-least-once boundary from the #3058 ruling; nothing here (or
// in any test) describes transport delivery as exactly-once.
//
// Registered in lib/stateful-writes.ts: this module is the only one allowed to
// mutate notify_post_workout_claims, so no caller can reconstruct a read-then-
// send path around the election.

import { db, writeTx } from "../db";
import { instantNow, now as clockNow } from "../clock";
import { parseInstant } from "../date";
import type { CanonicalInstant } from "../temporal-types";
import { POST_WORKOUT_DISPATCH_TIMEOUT_MS } from "./post-workout-queue";

// See the lease section above. Strictly greater than the queue's whole-task
// guard (150s), which is strictly greater than NOTIFICATION_DISPATCH_TIMEOUT_MS
// (120s) — asserted, not just written down. The 30s margin mirrors the queue's
// own provisional margin: generous against clock skew between the processes
// that share the database file, not measured.
export const POST_WORKOUT_CLAIM_LEASE_MS =
  POST_WORKOUT_DISPATCH_TIMEOUT_MS + 30_000;

// The election's verdict. `won` is the only outcome that may dispatch; the
// losing outcomes are the typed already-claimed / already-sent the #3058
// contract names, and carry no obligation at all.
export type PostWorkoutClaimResult = "won" | "already-claimed" | "already-sent";

interface ClaimRow {
  state: "pending" | "sent";
  claimed_at: CanonicalInstant;
}

// Elect a dispatcher for one activity's post-workout contact.
//
// One immediate transaction (savepoint-nested when the caller already holds
// writeTx, which the claim-owning core does — the eligibility re-checks and
// this insert must be one atomic judgment): INSERT the pending row, and on
// conflict judge the existing one. A stale pending claim is taken over by
// restamping `claimed_at` — same row, new lease, this caller is now the winner.
export function claimPostWorkoutDispatch(
  profileId: number,
  activityId: number
): PostWorkoutClaimResult {
  return writeTx(() => {
    const inserted = db
      .prepare(
        `INSERT INTO notify_post_workout_claims
           (profile_id, activity_id, state, claimed_at)
         VALUES (?, ?, 'pending', ?)
         ON CONFLICT(profile_id, activity_id) DO NOTHING`
      )
      .run(profileId, activityId, instantNow());
    if (inserted.changes === 1) return "won";
    const row = db
      .prepare(
        `SELECT state, claimed_at FROM notify_post_workout_claims
          WHERE profile_id = ? AND activity_id = ?`
      )
      .get(profileId, activityId) as ClaimRow;
    if (row.state === "sent") return "already-sent";
    const ageMs = clockNow().getTime() - parseInstant(row.claimed_at);
    if (ageMs < POST_WORKOUT_CLAIM_LEASE_MS) return "already-claimed";
    // A crashed winner's lease has expired: take the claim over. Plain UPDATE,
    // not a compare-and-swap — we are inside the immediate transaction, so no
    // other connection can move the row between the read above and this write.
    db.prepare(
      `UPDATE notify_post_workout_claims SET claimed_at = ?
        WHERE profile_id = ? AND activity_id = ? AND state = 'pending'`
    ).run(instantNow(), profileId, activityId);
    return "won";
  });
}

// Move the winner's claim to `sent`. Called from the SAME writeTx that stamps
// the one-shot marker (workout-presence.ts), so "a channel succeeded" becomes
// one atomic fact. Scoped to 'pending': a sent claim is final and is never
// restamped.
export function finalizePostWorkoutClaim(
  profileId: number,
  activityId: number
): void {
  db.prepare(
    `UPDATE notify_post_workout_claims SET state = 'sent'
      WHERE profile_id = ? AND activity_id = ? AND state = 'pending'`
  ).run(profileId, activityId);
}

// Release a claim whose dispatch delivered NOTHING (total failure, or no
// channel configured), so the retry band elects a fresh winner instead of
// waiting out the lease. Scoped to 'pending' — a sent claim can never be
// released back into the world.
export function releasePostWorkoutClaim(
  profileId: number,
  activityId: number
): void {
  db.prepare(
    `DELETE FROM notify_post_workout_claims
      WHERE profile_id = ? AND activity_id = ? AND state = 'pending'`
  ).run(profileId, activityId);
}

// Test/inspection read: the claim's current state, or null when unclaimed.
export function postWorkoutClaimState(
  profileId: number,
  activityId: number
): "pending" | "sent" | null {
  const row = db
    .prepare(
      `SELECT state FROM notify_post_workout_claims
        WHERE profile_id = ? AND activity_id = ?`
    )
    .get(profileId, activityId) as Pick<ClaimRow, "state"> | undefined;
  return row?.state ?? null;
}
