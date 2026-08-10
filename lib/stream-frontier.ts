// THE stream FRONTIER: did this stream's newest row MOVE? (issue #2341) — pure, no
// DB, no clock.
//
// ── The quantity that could not be thresholded ───────────────────────────────
//
// Every "is this stream silent" predicate in the app used to threshold
//
//     now − MAX(stream.ts)  =  (minutes the device was not producing)
//                           +  (how far behind the pipeline's pushes are running)
//
// and on the Health Connect exporter the second term is the same SIZE as the first:
// measured directly at two known instants, the ingest lag was 60.8 min and 30.7 min,
// and #2263's census over 1223 pushes puts the push gap at median 16 / p90 34 / p99 67
// minutes. So no threshold on that quantity can separate a watch on a charger from a
// watch on a wrist behind a slow push — and raising the number makes the motivating
// incident (charger at 21:05, bedtime slot at 22:00, ~55 minutes of observed silence)
// undetectable, because it is SHORTER than a worn watch's own lag on a slow night.
//
// ── The quantity that can ────────────────────────────────────────────────────
//
// A watch on the wrist behind a slow pipeline ADVANCES `MAX(stream.ts)` on every push:
// the rows arrive late, but they arrive, and each push carries newer ones than the
// last. A watch on the charger leaves it FROZEN while pushes keep landing. That
// distinction contains no lag term at all, needs no fitted estimate (#2146 constraint
// 2 forbids one), and is invisible to any reader that looks at the frontier ONCE —
// which is why it had to become stored state.
//
// This module owns the state transition. It is a fold over the push sequence:
//
//     state ← observe(state, MAX(stream.ts) as it stands after this push, at)
//
// applied by the INGEST path, in the transaction that reads the frontier it records
// (lib/stream-frontier-db.ts), so an observation can never disagree with the rows it
// describes. The predicates then ask one question of the folded state — "have the last
// N successful pushes landed without advancing this?" — instead of asking the clock.
//
// PURE by construction: `at` is supplied by the caller's clock seam, both instants are
// compared as epoch milliseconds (never as text — two serializations of one UTC moment
// compare LEXICALLY wrong while every query still looks right, #2096/#2205), and
// nothing here reads a database.

import { parseUtcSql } from "./date";

/**
 * What one observation found. `empty` is NOT a kind of frozen: a stream that has never
 * delivered anything has no frontier to be frozen against, and reporting it as silent
 * would announce a device the profile does not have.
 */
export type FrontierMove = "advanced" | "frozen" | "empty";

/** The folded state for one (profile, provider, stream), as stored. */
export interface StreamFrontierState {
  /**
   * The newest row's instant as of the last observation — canonical UTC, or null when
   * the stream has never delivered anything for this profile.
   */
  frontierAt: string | null;
  /** When the frontier was last observed to ADVANCE — canonical UTC. */
  advancedAt: string;
  /** When it was last observed at all, advancing or not — canonical UTC. */
  observedAt: string;
  /**
   * Successful syncs observed SINCE that advance, each of which left the frontier
   * exactly where it was. This is the evidence the predicates count.
   */
  syncsSinceAdvance: number;
}

/**
 * Did the frontier move? Compared as instants, not as strings.
 *
 * STRICTLY greater is an advance. A re-push of the identical rolling window — which is
 * what the exporter sends when the device stopped producing — leaves `MAX(ts)` exactly
 * where it was, and that is precisely the observation this exists to record. A frontier
 * that moved BACKWARD (a row deleted, a re-import sweep) is not an advance either; the
 * new value is still adopted below, because an honest frontier that got older is better
 * than a stale one that looks young.
 */
export function classifyFrontier(
  previous: string | null,
  observed: string | null
): FrontierMove {
  if (observed == null) return "empty";
  if (previous == null) return "advanced";
  const prevMs = parseUtcSql(previous)?.getTime();
  const nextMs = parseUtcSql(observed)?.getTime();
  if (prevMs == null || nextMs == null) return "advanced";
  return nextMs > prevMs ? "advanced" : "frozen";
}

/**
 * Fold one observation into the state. `at` is the instant the observation was made
 * (the caller's clock seam), `observed` is `MAX(stream.ts)` as it stands right then.
 *
 * The counter resets on an advance and on an empty stream, and only increments on a
 * genuine freeze — so `syncsSinceAdvance` always answers exactly "how many successful
 * pushes have landed since this stream last produced anything new".
 */
export function observeFrontier(
  previous: StreamFrontierState | null,
  observed: string | null,
  at: string
): StreamFrontierState {
  const move = classifyFrontier(previous?.frontierAt ?? null, observed);
  if (move === "frozen")
    return {
      // Adopt the observed value even though it did not advance: it is what the rows
      // say now, and the next comparison must be made against the truth.
      frontierAt: observed,
      advancedAt: previous?.advancedAt ?? at,
      observedAt: at,
      syncsSinceAdvance: (previous?.syncsSinceAdvance ?? 0) + 1,
    };
  return {
    frontierAt: observed,
    advancedAt: at,
    observedAt: at,
    syncsSinceAdvance: 0,
  };
}

/**
 * N — how many successive successful syncs must land WITHOUT advancing the frontier
 * before the source is called stopped.
 *
 * ONE push carrying nothing new is ordinary jitter: the exporter batches, and a push
 * can legitimately land between two of the device's own writes. TWO consecutive ones,
 * with the provider syncing ok, means the source has stopped producing. At Health
 * Connect's measured median 16-minute cadence (#2263) that is ~30 minutes of REAL
 * evidence — evidence, not elapsed clock — and it is available at the slot minute.
 *
 * Declared ONCE, here, rather than per stream in the registry: this is a property of
 * what a push MEANS, not of any one stream's wear pattern. What each surface declares
 * for itself is the FLOOR on the frontier's own age (the registry's
 * `quiet.dipToleranceMin` and `reminder.frontierFloorMin`), because that is the part
 * that genuinely differs — one is asked continuously, the other once at a bedtime slot.
 */
export const FROZEN_SYNC_EVIDENCE = 2;

/** Why the frontier is not (yet) known to be frozen. */
export type FrontierUnfrozen =
  /** The last push advanced it — the source is producing, however late it arrives. */
  | "advanced"
  /**
   * Not enough successful pushes have landed against this frontier yet: one quiet push
   * is jitter, and a stream that has never been observed has no evidence at all.
   */
  | "no-recent-sync";

export type FrontierEvidence =
  { frozen: true; syncs: number } | { frozen: false; why: FrontierUnfrozen };

/**
 * THE frozen question, asked the same way by every predicate that asks it.
 *
 * `null` means the stream has never been observed — the app was deployed, or the
 * provider connected, and no push has landed since. That is deliberately NOT frozen:
 * absence of evidence is not evidence, and the first push repairs it.
 */
export function frontierEvidence(
  syncsSinceAdvance: number | null,
  required: number = FROZEN_SYNC_EVIDENCE
): FrontierEvidence {
  if (syncsSinceAdvance == null)
    return { frozen: false, why: "no-recent-sync" };
  if (syncsSinceAdvance <= 0) return { frozen: false, why: "advanced" };
  if (syncsSinceAdvance < required)
    return { frozen: false, why: "no-recent-sync" };
  return { frozen: true, syncs: syncsSinceAdvance };
}
