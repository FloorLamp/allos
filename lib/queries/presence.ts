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
