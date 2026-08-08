// "Has this profile done this lift?" — ONE pure question over the (date, exercise)
// rows the coaching gather already holds, plus the ONE threshold that turns the
// count into a policy (#2223).
//
// The count is the FACT; the threshold is the POLICY, and they are kept apart so a
// later change of mind edits one constant here rather than a gather or a formatter.
// Today's only consumer is the workout nudge's "📖 How to" deep link (#734), which
// is an INTRODUCTION to a lift rather than a reference for one: the guide stays
// permanently reachable in `ExerciseDetailPanel`, so someone who wants to re-read
// the cues goes there. Owner decision (2026-08-06): the link goes only to a lift
// with ZERO sessions in the recommendation window.
//
// No DB, no network, no clock.

import { exerciseHistoryKey } from "./lifts";
import type { DatedExercise } from "./workout-recommendation";

/**
 * How many SESSIONS of `exercise` the rows contain.
 *
 * Two things this function is careful about, both load-bearing:
 *
 * 1. IDENTITY IS `exerciseHistoryKey`, never the raw display name. The guide index
 *    (`lib/exercise-guides.ts`) is keyed on it too, so "Curl", "Barbell Curl" and
 *    "Dumbbell Curl" all resolve to the ONE `curl` guide. If this counted display
 *    names, a profile that logs "Dumbbell Curl" and gets recommended "Barbell Curl"
 *    would be told it had never done the lift whose guide it is about to receive.
 *    Both halves of the decision must agree on what a lift IS (#482/#733).
 * 2. DISTINCT DATES, not rows. `getRecentDatedExercises` returns one row per SET,
 *    so three working sets on one day is ONE session, not three.
 *
 * WINDOW: whatever the caller's rows cover — in production the coaching gather's
 * 56 days. That bound is the INTENDED SEMANTIC, not a leak: a lift dropped for two
 * months earns its cues back on return, which reads as a re-familiarization. Do not
 * "fix" this into an all-time count. Besides changing the meaning, an all-time count
 * is considerably more expensive: SQLite cannot call `baseLiftName`, so the identity
 * would have to go through the `exerciseHistoryKey` preimage set (#394) instead of a
 * bounded scan already in memory.
 */
export function exerciseSessionCount(
  rows: readonly DatedExercise[],
  exercise: string
): number {
  const key = exerciseHistoryKey(exercise);
  const dates = new Set<string>();
  for (const row of rows) {
    if (exerciseHistoryKey(row.exercise) === key) dates.add(row.date);
  }
  return dates.size;
}

/**
 * Sessions after which a lift counts as KNOWN. One logged session is enough — the
 * introduction has happened, and the guide remains one tap away in the exercise
 * panel for anyone who wants it again.
 */
export const FAMILIAR_AFTER_SESSIONS = 1;

/**
 * Whether a lift is NEW to this profile, i.e. still owed an introduction.
 *
 * ABSENT MEANS "NO", NOT "YES". `undefined` is "we don't know", and an unknown must
 * not earn a contact: the attention doctrine (`docs/internals/findings.md`) lets the
 * system reduce contact unilaterally but never increase it, so a path that forgets
 * to thread the count goes quiet rather than resurrecting the noise. This is the one
 * place that rule is expressed; callers just ask.
 */
export function isNewLift(sessions: number | undefined): boolean {
  return sessions !== undefined && sessions < FAMILIAR_AFTER_SESSIONS;
}
