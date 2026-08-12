// THE post-workout one-shot marker, and the one thing a merge has to do with it
// (issue #2570).
//
// ── Why this is its own leaf module ──────────────────────────────────────────
//
// The key and its builder used to live in lib/notifications/workout-presence.ts,
// beside the dispatch that stamps it. That module statically pulls the whole
// notification stack — dispatch, the fan-out, the Telegram client, the recap
// builders — and the merge path now has to read and write this marker, so importing
// it there would have dragged all of that into every activity merge, including the
// unattended one that runs inside an ingest transaction. The literal is declared here
// and re-exported there, so nothing that already imports it changes.
//
// ── What went wrong (#2570) ──────────────────────────────────────────────────
//
// One bike ride produced THREE post-workout notifications in one afternoon. Health
// Connect is a hub: three apps mirrored the same ride into it, and one of them wrote
// it twice — once copying another app's record and once as its own untyped record
// starting 32 seconds earlier. Activity identity is the exact start instant, so the
// ride landed as two rows, then four when the direct Strava sync ran.
//
//   14:02  a Health Connect push inserts row A          → send 1
//   14:18  a second push inserts row B; A+B are a
//          high-confidence duplicate pair, but they are
//          SAME-SOURCE, so auto-merge declines            → send 2
//   15:00  the Strava sync inserts two more rows; the
//          cluster is now cross-source and auto-merges,
//          keeping a row created seconds earlier and
//          dropping A, B and the fourth                   → send 3
//
// The third send is not a failure to suppress: **auto-merge caused it**. The keeper
// rule prefers a sourced row, then the richer one — so when a richer provider arrives
// after a poorer one, the keeper is a row that did not exist a second ago and carries
// no marker. `writeActivityFold` already carries logs, tombstones, routes, telemetry,
// pair decisions and provenance into that keeper; it did not carry "we already told
// the user about this session".
//
// The tell is that it was ARRIVAL-ORDER DEPENDENT. The previous day's walk, from the
// same two providers, produced exactly one notification — because the rich row arrived
// FIRST, so the Health Connect copy lost the keeper contest and was merged away inside
// its own 60-second dispatch window. Same providers, same merge rule, same code,
// opposite outcomes, decided by which sync happened to run first. That the send fired
// once per session at all was an emergent side effect of merge timing, declared
// nowhere, and it failed in BOTH directions: silent when the merge declined, and
// re-announcing when the merge manufactured a new id.
//
// This module owns the half of the fix that lives at the point where the identity is
// destroyed. The other half — the dispatch declining at fire time when a twin has
// already been announced — is in workout-presence.ts, and it is genuinely a second
// thing: sends 1 and 2 involved NO merge at all, so there was no fold to carry
// anything through.
//
// Contact-consent (docs/internals/findings.md §2): both halves only ever REDUCE
// contact. Neither can cause a send that would not otherwise have happened.
//
// ── #2385: how this would show itself wrong ──────────────────────────────────
//
// WORKING: for a day's activity rows, the number of `notify_last_post_workout_*`
// markers that belong to rows a high-confidence detection groups together is at most
// one per group — a local query over rows the instance already holds, and the one that
// would have caught this on 2026-08-12 (two orphan markers and a third fresh one, all
// for one ride).
// WRONG: a day with two genuinely separate sessions that produced one contact. Their
// clock windows do not overlap, so no high-confidence pair exists between them and
// nothing here can reach them — if it happens, the detector is what is wrong, not this.
// DECEPTIVE SUCCESS: total post-workout sends falling. It falls just as well if the
// guard is over-broad and is eating real second workouts, and it falls hardest for
// someone who trains twice a day — the person it would be hurting. Count contacts per
// DETECTED SESSION, never per day.

import { getProfileSetting, setProfileSetting } from "../settings";

export const POST_WORKOUT_MARKER_PREFIX = "notify_last_post_workout_";

export function postWorkoutFinishMarkerKey(activityId: number): string {
  return `${POST_WORKOUT_MARKER_PREFIX}${activityId}`;
}

/** The stored value (the profile-local date of the send), or null when unannounced. */
export function postWorkoutAnnouncedOn(
  profileId: number,
  activityId: number
): string | null {
  return (
    getProfileSetting(profileId, postWorkoutFinishMarkerKey(activityId)) ?? null
  );
}

/**
 * Carry the announcement fact from a merge's dropped rows onto its keeper.
 *
 * Called from `writeActivityFold`, inside the caller's write transaction and BEFORE
 * the drops are deleted, so the markers are still readable. Returns the id of the drop
 * whose marker was inherited, or null when there was nothing to carry.
 *
 * Three deliberate choices:
 *
 *  - A keeper that already has its own marker is left alone. Its own send is the one
 *    that happened for its own id, and re-stamping it with a drop's date would move a
 *    date backwards for no benefit.
 *  - The DROPS' markers are NOT deleted. They are inert by construction — an
 *    AUTOINCREMENT id never recycles (#203), so a marker for a deleted row can never
 *    suppress another session's reminder — and deleting them would make this fold a
 *    destructive settings write inside an ingest transaction for no gain.
 *  - UNDO DOES NOT REVERSE IT. `revertActivityMerge` restores a drop under a NEW id,
 *    which has no marker of its own, so the inherited one on the keeper is all that
 *    remembers the session was announced. Reversing it could only ever cause a second
 *    send for a session already announced, and the contact-consent rule permits
 *    reducing contact unilaterally, never increasing it.
 */
export function carryPostWorkoutMarker(
  profileId: number,
  keepId: number,
  dropIds: readonly number[]
): number | null {
  if (postWorkoutAnnouncedOn(profileId, keepId) != null) return null;
  for (const dropId of dropIds) {
    const value = postWorkoutAnnouncedOn(profileId, dropId);
    if (value == null) continue;
    setProfileSetting(profileId, postWorkoutFinishMarkerKey(keepId), value);
    return dropId;
  }
  return null;
}
