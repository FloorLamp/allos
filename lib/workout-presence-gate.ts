// Presence gates for the "time to work out" reminder (issue #981). The #921
// revisit: presence-as-a-send-gate was deliberately declined in v1 ("revisit if it
// annoys in practice"), and it did — the slot fired MID-workout and the presence-aware
// rest line even read "you're training now". Both gates here read the ONE derived
// `workoutPresence` (never a second presence derivation, #221) plus the SAME tracked
// target scopes the nudge already reasons over, and both are MARKER-NEUTRAL: the
// reminder returns null, so the tick never stamps `notify_last_workout`, and the normal
// lifecycle resumes on the next scheduled attempt.
//
//   1. active  ⇒ HOLD  — a live session is running; a "time to train" ping during it is
//      absurd. Held out of the send AND the daily marker (the #837 illness-hold shape),
//      so a discarded false-start draft doesn't consume the day.
//   2. finished + credits a TRACKED target ⇒ SKIP — the finish/recap message (#921/#924)
//      already owns that moment. STRICTLY window-scoped (the finished window is the #921
//      constant) and never marker-consuming: the next scheduled attempt evaluates fresh,
//      so a dog-walk crediting a "walk 5×/week" habit doesn't silence the day's lift
//      reminder — only this one attempt.
//
// DELIBERATELY not gated (pinned as tests): a finish that credits NOTHING tracked (a
// synced walk with no walking target) does NOT skip — type-awareness comes from target
// SCOPING, not from "did anything finish"; and a GENERIC finished never holds (the
// target math already handles "just finished the real workout" — the session credits
// its target before the next tick).

import { regionsForGroup, type BodyGroup, type MuscleRegion } from "./lifts";
import type { ActivityType } from "./types/training";
import type { WorkoutPresence } from "./workout-presence";

export type WorkoutReminderGate = "hold" | "skip" | "fire";

// The credit "footprint" of the just-finished activity — every scope dimension a
// frequency target can be declared on (mirrors getFrequencyTargetProgress's scope
// semantics exactly, so "credits a target" means the identical thing here as in the
// weekly count). Gathered by getFinishedActivityCredit (lib/queries/presence.ts).
export interface FinishedActivityCredit {
  // The activity's own type, plus any multi-part component types — both feed a
  // `type`-scoped target the same way the weekly rollup's typeDates does.
  type: ActivityType;
  componentTypes: string[];
  // Distinct muscle regions the session's exercise_sets trained — for `region`
  // (direct) and `group` (region-union) targets.
  regions: MuscleRegion[];
  // Distinct regions a recovery session MOBILIZED — for `mobility_region` targets
  // (#482: trained ≠ mobilized, so a separate dimension from `regions`).
  mobilityRegions: MuscleRegion[];
}

// A tracked frequency target's scope — the {scope_kind, scope_value} the reminder
// already reads off input.routine. `food_group` targets are never credited by a
// workout finish, so they simply don't match.
export interface TrackedScope {
  scope_kind: string; // 'type' | 'region' | 'group' | 'mobility_region' | 'food_group'
  scope_value: string;
}

// Does the just-finished activity credit ANY of the tracked target scopes? Pure —
// the same scope→credit rules getFrequencyTargetProgress applies, so a finish that
// increments a weekly count here is exactly one that increments it there.
export function finishCreditsTrackedScope(
  credit: FinishedActivityCredit,
  scopes: readonly TrackedScope[]
): boolean {
  return scopes.some((s) => {
    switch (s.scope_kind) {
      case "type":
        return (
          credit.type === s.scope_value ||
          credit.componentTypes.includes(s.scope_value)
        );
      case "region":
        return credit.regions.includes(s.scope_value as MuscleRegion);
      case "group":
        return regionsForGroup(s.scope_value as BodyGroup).some((r) =>
          credit.regions.includes(r)
        );
      case "mobility_region":
        return credit.mobilityRegions.includes(s.scope_value as MuscleRegion);
      default:
        // food_group (and any future non-activity scope) — a workout finish never
        // credits it.
        return false;
    }
  });
}

// The gate decision for the workout reminder. `credit` is the finished activity's
// footprint (null unless presence is `finished`); `scopes` are the tracked target
// scopes the reminder reads. Both non-"fire" outcomes make recommendWorkout return
// null — held/skipped out of the send AND the daily marker.
export function workoutPresenceGate(
  presence: WorkoutPresence,
  credit: FinishedActivityCredit | null,
  scopes: readonly TrackedScope[]
): WorkoutReminderGate {
  // Gate 1 — mid-workout ⇒ hold. `active` already requires today's live draft with
  // recent liveness (the #451 signal), so a retro/completed log or an import (which
  // arrives completed) can never read as active and never holds here.
  if (presence.state === "active") return "hold";
  // Gate 2 — a credit-bearing finish inside the finished window ⇒ skip this attempt.
  if (
    presence.state === "finished" &&
    credit != null &&
    finishCreditsTrackedScope(credit, scopes)
  )
    return "skip";
  return "fire";
}
