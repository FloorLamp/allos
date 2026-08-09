// Workout day-density — DB read layer (issue #186). Profile-scoped grouped passes
// over `activities` (sessions + total minutes per day, and per day AND type for
// the Trends day-history). Distinct from the sidebar calendar's
// `getActivityDates` (which spans ALL activity kinds) — this is workout-specific
// and carries per-day counts/minutes, not just a date set.
import { db, today } from "../../db";
import type { ActivityType } from "../../types";
import {
  buildActiveDaysStrip,
  type ActiveDaysStrip,
  type WorkoutDayDensity,
} from "../../workout-heatmap";
import { shiftDateStr } from "../../date";

// Sessions + total training minutes per profile-local day, on/after `since`. ONE
// SQL pass, profile-scoped. `activities.date` is already the profile-local calendar
// day at ingest (issue #94), so grouping by it buckets in the profile timezone.
export function getWorkoutDayDensity(
  profileId: number,
  since: string
): WorkoutDayDensity[] {
  return db
    .prepare(
      `SELECT date,
              COUNT(*) AS count,
              CAST(COALESCE(SUM(duration_min), 0) AS INTEGER) AS minutes
         FROM activities
        WHERE profile_id = ? AND date >= ?
        GROUP BY date
        ORDER BY date ASC`
    )
    .all(profileId, since) as WorkoutDayDensity[];
}

// Sessions + minutes per profile-local day AND activity type, in [since, until] —
// the gather behind the Trends → Fitness sessions-by-type day history (the
// group×day matrix twin of the density heatmap above). Same single grouped
// pass, one extra GROUP BY column; `type` is the canonical clinical identity
// for an activity row (the ACTIVITY_TYPES tuple), so the matrix keys on it
// rather than re-deriving a family from free-text titles.
export interface WorkoutTypeDay {
  date: string; // YYYY-MM-DD, profile-local
  type: ActivityType;
  count: number; // sessions of this type that day
  minutes: number; // total minutes (0 when all durations null)
}

export function getWorkoutTypeDays(
  profileId: number,
  since: string,
  until: string
): WorkoutTypeDay[] {
  return db
    .prepare(
      `SELECT date,
              type,
              COUNT(*) AS count,
              CAST(COALESCE(SUM(duration_min), 0) AS INTEGER) AS minutes
         FROM activities
        WHERE profile_id = ? AND date >= ? AND date <= ?
        GROUP BY date, type
        ORDER BY date ASC, type ASC`
    )
    .all(profileId, since, until) as WorkoutTypeDay[];
}

export function getActiveDaysStrip(
  profileId: number,
  length = 14
): ActiveDaysStrip {
  const end = today(profileId);
  const since = shiftDateStr(end, -(length - 1));
  return buildActiveDaysStrip(
    getWorkoutDayDensity(profileId, since),
    end,
    length
  );
}
