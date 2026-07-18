// DB gather for derived workout presence (issue #921). The state machine is the
// pure computeWorkoutPresence (lib/workout-presence.ts); this only selects the
// candidate `activities` rows and hands them over with the profile's clock. One
// computation, so every consumer reads it through here.

import { db, today } from "../db";
import { shiftDateStr } from "../date";
import { getTimezone } from "../settings/display";
import {
  computeWorkoutPresence,
  type PresenceActivityRow,
  type WorkoutPresence,
} from "../workout-presence";
import type { FinishedActivityCredit } from "../workout-presence-gate";
import type { ActivityType } from "../types/training";
import { parseComponents } from "../types/training";
import { regionForExercise, type MuscleRegion } from "../lifts";
import { regionsForMove } from "../mobility-coverage";

// A day of slack before `today` so a session that ended just after local
// midnight (its `date` still yesterday) stays inside the finished window.
export function getWorkoutPresence(
  profileId: number,
  now: Date = new Date()
): WorkoutPresence {
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);
  const since = shiftDateStr(todayStr, -1);
  const rows = db
    .prepare(
      `SELECT id, type, title, date, start_time, end_time, duration_min,
              created_at, updated_at, source
         FROM activities
        WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, since) as PresenceActivityRow[];
  return computeWorkoutPresence(rows, now, tz, todayStr);
}

// The credit "footprint" of a single (just-finished) activity — the scope dimensions
// a frequency target can be declared on — for the workout-reminder SKIP gate (#981).
// Uses the SAME scope→credit rules as getFrequencyTargetProgress: the activity's type
// + component types (`type` scope), its exercise_sets' regions (`region`/`group`), and,
// for a recovery session, the regions its moves mobilized (`mobility_region`). Scoped
// by profile_id on every read (exercise_sets reaches it via its parent activity).
export function getFinishedActivityCredit(
  profileId: number,
  activityId: number
): FinishedActivityCredit {
  const act = db
    .prepare(
      `SELECT type, components FROM activities WHERE id = ? AND profile_id = ?`
    )
    .get(activityId, profileId) as
    | { type: ActivityType; components: string | null }
    | undefined;
  if (!act)
    return {
      type: "strength",
      componentTypes: [],
      regions: [],
      mobilityRegions: [],
    };

  const components = parseComponents(act.components);
  const componentTypes = Array.from(
    new Set(components.map((c) => c?.type).filter((t): t is ActivityType => !!t))
  );

  const exRows = db
    .prepare(
      `SELECT DISTINCT s.exercise AS exercise
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.id = ? AND a.profile_id = ?`
    )
    .all(activityId, profileId) as { exercise: string }[];
  const regions = new Set<MuscleRegion>();
  for (const r of exRows) {
    const region = regionForExercise(r.exercise);
    if (region) regions.add(region);
  }

  const mobilityRegions = new Set<MuscleRegion>();
  if (act.type === "recovery") {
    for (const c of components) {
      if (c?.type !== "recovery" || typeof c.name !== "string") continue;
      for (const region of regionsForMove(c.name)) mobilityRegions.add(region);
    }
  }

  return {
    type: act.type,
    componentTypes,
    regions: Array.from(regions),
    mobilityRegions: Array.from(mobilityRegions),
  };
}
