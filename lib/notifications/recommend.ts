// "What should I train today" for the Telegram workout reminder — now a thin
// FORMATTER over the unified next-workout core (#221) rather than a second engine.
// It gathers the same coaching input the dashboard/overview use, runs the shared
// `recommendNextWorkout` (bounded window, recovery exclusion, weekday habit,
// behind-target composition, frequency-ranked exercise list) for the focus +
// exercises, and consults the full coaching engine for rest/on-track awareness so
// the reminder can reframe on a recovery day. Deterministic, no API. All day
// boundaries follow the configured app timezone (via gatherCoachingInput).

import { frequencyScopeLabel } from "../goals";
import { recommendCoaching } from "../coaching";
import { recommendNextWorkout } from "../workout-recommendation";
import { isWorkoutNudgeSuppressed } from "../workout-nudge";
import { gatherCoachingInput } from "../queries";
import { getFindingSuppressions } from "../queries/upcoming";
import type { CoachingInput } from "../coaching";
import type { WorkoutRecommendation } from "./workout-format";

export type { WorkoutRecommendation };

// `gathered` (#447): the notify tick already runs the full coaching gather once per
// profile per tick for the rest-episode reconcile; passing it here lets the workout
// slot reuse that single scan instead of repeating the heaviest per-profile read.
// Omitted (the request-time/manual callers) ⇒ gather fresh.
export function recommendWorkout(
  profileId: number,
  gathered?: CoachingInput
): WorkoutRecommendation | null {
  // One gather, one core — the dashboard, the overview, and this reminder all
  // read the same computation, so they can't drift.
  const input = gathered ?? gatherCoachingInput(profileId, "kg", "km");
  const nw = recommendNextWorkout(input);

  // Route through the shared findings-suppression bus (#227/#245): the nudge is
  // driven by the profile's behind (unmet) weekly targets, each surfaced on Upcoming
  // as a `training:<id>` finding via the SAME trainingSignalKey. When every one is
  // dismissed/snoozed there, return null — holding the recommendation out of BOTH the
  // send AND the daily `notify_last_workout` slot marker (the tick only marks the slot
  // on a delivered message), so un-dismissing resumes the normal lifecycle.
  const suppressions = getFindingSuppressions(profileId);
  if (
    isWorkoutNudgeSuppressed(
      nw.behind.map((t) => t.id),
      suppressions,
      input.today
    )
  )
    return null;

  const recs = recommendCoaching(input);

  const behind = input.routine
    .filter((t) => !t.met)
    .map(
      (t) =>
        `${frequencyScopeLabel(t.target.scope_kind, t.target.scope_value)} ${t.count}/${t.per_week}`
    );

  const top = recs[0];
  const rest =
    top?.kind === "rest" ? { title: top.title, detail: top.detail } : null;
  const onTrack =
    top?.kind === "ontrack" ? { title: top.title, detail: top.detail } : null;

  // Nothing to suggest and nothing to note → no reminder.
  if (!nw.focus.length && !nw.exercises.length && !rest && !onTrack)
    return null;

  return {
    focus: nw.focus,
    exercises: nw.exercises,
    behind,
    rest,
    onTrack,
    // Carry the resolved routine day label (#740) so the nudge names the actual
    // sequence day. Null when no active routine resolved a session.
    sessionLabel: nw.session?.label ?? null,
    // Deload-week softening (#741): the same flag every surface reads, carried from
    // the resolved session so the nudge phrases the deload instead of pushing hard.
    deloadWeek: nw.session?.deloadWeek ?? false,
  };
}
