// Workout-density heatmap — DB read layer (issue #186). One profile-scoped grouped
// pass over `activities` (sessions + total minutes per day), assembled into the
// trailing-12-month grid by the pure builder in lib/workout-heatmap. Distinct from
// the sidebar calendar's `getActivityDates` (which spans ALL activity kinds) — this
// is workout-specific and carries per-day counts/minutes, not just a date set.
import { db, today } from "../../db";
import { getWeekStart } from "../../settings";
import {
  buildWorkoutHeatmap,
  heatmapStart,
  type WorkoutDayDensity,
  type WorkoutHeatmap,
} from "../../workout-heatmap";

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

// The trailing ~12-month workout heatmap for the profile: `weeks` week-columns
// ending on the week of "today" (profile timezone), aligned to the profile's first
// weekday. The query window is derived from the same alignment so no data outside
// the grid is fetched.
export function getWorkoutHeatmap(
  profileId: number,
  weeks = 53
): WorkoutHeatmap {
  const end = today(profileId);
  const weekStart = getWeekStart(profileId);
  const since = heatmapStart(end, weeks, weekStart);
  const density = getWorkoutDayDensity(profileId, since);
  return buildWorkoutHeatmap(density, end, weeks, weekStart);
}
