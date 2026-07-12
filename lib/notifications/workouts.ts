// Builds the workout reminder: a recommended session for today, derived from the
// unified next-workout core (usual weekday schedule + weekly targets behind on,
// avoiding the muscle region trained yesterday). On a recovery day it reframes as
// a rest note, and it celebrates an on-track week, instead of blindly pushing a
// workout (#221). Returns null when there's nothing to suggest or note.

import { recommendWorkout } from "./recommend";
import { formatWorkoutReminder } from "./workout-format";
import type { NotificationMessage } from "./types";
import type { CoachingInput } from "../coaching";

// `gathered` (#447): forwards the tick's once-per-profile coaching gather to
// recommendWorkout so the workout slot and the rest-episode reconcile share ONE
// scan. Omitted (manual mode) ⇒ recommendWorkout gathers fresh.
export function buildWorkoutTargetReminder(
  profileId: number,
  gathered?: CoachingInput
): NotificationMessage | null {
  return formatWorkoutReminder(recommendWorkout(profileId, gathered));
}
