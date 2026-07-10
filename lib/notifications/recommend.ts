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
import { gatherCoachingInput } from "../queries";
import type { WorkoutRecommendation } from "./workout-format";

export type { WorkoutRecommendation };

export function recommendWorkout(
  profileId: number
): WorkoutRecommendation | null {
  // One gather, one core — the dashboard, the overview, and this reminder all
  // read the same computation, so they can't drift.
  const input = gatherCoachingInput(profileId, "kg", "km");
  const nw = recommendNextWorkout(input);
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

  return { focus: nw.focus, exercises: nw.exercises, behind, rest, onTrack };
}
