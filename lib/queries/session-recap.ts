// Server-side gather for the post-workout session recap (issue #924). The ONE DB
// read layer feeding both the finished-window dashboard card and the recap-led
// finish nudge — it maps the stored activity + its recent per-exercise history
// onto the pure sessionRecap computation, so those two surfaces (and the live
// form step, which computes the same recap client-side) can't drift (#221).

import { getActivityEditData } from "./training/activities";
import { getRecentExerciseHistory } from "./training/strength";
import { getLatestBodyMetric } from "./metrics";
import {
  recapSessionFromEditData,
  sessionRecap,
  type Recap,
} from "../session-recap";

// The recap of one activity (by id), or null when the activity is missing. Works
// for any activity type — a pure-cardio or import row simply has no strength
// exercises, so it recaps honestly (duration only, no target/volume data).
export function getSessionRecap(
  profileId: number,
  activityId: number
): Recap | null {
  const data = getActivityEditData(profileId, activityId);
  if (!data) return null;
  const bodyweightKg = getLatestBodyMetric(profileId, "weight") ?? 0;
  const history = getRecentExerciseHistory(profileId);
  const session = recapSessionFromEditData(data, { bodyweightKg });
  // The activity is in its own history (server-side) — exclude it from prior
  // comparisons so a PR/delta isn't computed against itself.
  return sessionRecap(session, history, { currentActivityId: activityId });
}
