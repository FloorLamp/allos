// Pure suppression decision for the workout-recommendation nudge (#245), routing it
// through the shared findings-suppression bus like the refill/preventive nudges (#227).
// The DB gather + Telegram build lives in lib/notifications/recommend.ts (recommendWorkout);
// this file only owns the SHARED signal key and the DECISION, so both stay unit-tested
// with no DB/network.
//
// The workout nudge synthesizes a single "train today" suggestion (the #221 unified
// core, lib/workout-recommendation.ts) with no 1:1 dedupeKey to the per-target
// `training:<id>` Upcoming findings — so #227 deferred it. The bridge: the
// recommendation carries its originating behind (unmet) weekly-target ids, each of
// which the Upcoming page surfaces as a `training:<id>` finding. When EVERY such
// finding is dismissed/snoozed there, the nudge is held.
//
// Frozen-marker discipline (#227/#183/#226): a suppressed recommendation is held out
// of BOTH the send and the daily `notify_last_workout` slot marker — recommendWorkout
// returns null, so the tick never marks the slot as sent for the day and un-dismissing
// (or a snooze expiring) resumes the normal lifecycle. A habit/rest/on-track
// recommendation (no behind targets) has no training finding to line up with, so it is
// never gated; partial suppression (one behind target still live) still sends.

import { isSuppressed, type SuppressionRecord } from "./upcoming-suppress";

// The stable suppression/identity key for a weekly training-target finding:
// `training:<id>`. The SINGLE source of truth for the key — the Upcoming training item
// (lib/queries/upcoming.ts) AND the workout nudge derive from it, so a page dismissal
// and its push cousin line up on the same string (issue #245, the #227 pattern).
export function trainingSignalKey(targetId: number): string {
  return `training:${targetId}`;
}

// Decide whether the workout nudge is suppressed, given the recommendation's
// originating behind-target ids (nulls — id-less test targets — are ignored), the
// profile's finding-suppression map, and today's profile-local date. Pure.
//   - No usable behind-target ids ⇒ NOT suppressed: a habit/rest/on-track nudge has no
//     `training:<id>` finding to line up with, so the bus doesn't gate it.
//   - Otherwise suppressed only when EVERY originating target's `training:<id>` finding
//     is currently dismissed/snoozed — a single still-live target keeps the nudge on.
export function isWorkoutNudgeSuppressed(
  behindTargetIds: readonly (number | null)[],
  suppressions: Map<string, SuppressionRecord>,
  today: string
): boolean {
  const ids = behindTargetIds.filter((id): id is number => id != null);
  if (ids.length === 0) return false;
  return ids.every((id) => {
    const rec = suppressions.get(trainingSignalKey(id));
    return rec != null && isSuppressed(rec, today);
  });
}
