// Workout-density heatmap — DB read layer (issue #186). One profile-scoped grouped
// pass over `activities` (sessions + total minutes per day), assembled into the
// trailing-12-month grid by the pure builder in lib/workout-heatmap. Distinct from
// the sidebar calendar's `getActivityDates` (which spans ALL activity kinds) — this
// is workout-specific and carries per-day counts/minutes, not just a date set.
import { db, today } from "../../db";
import { getWeekStart } from "../../settings";
import {
  buildWorkoutHeatmap,
  buildActiveDaysStrip,
  heatmapStart,
  type ActiveDaysStrip,
  type WorkoutDayDensity,
  type WorkoutHeatmap,
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

// The trailing workout heatmap for the profile: `weeks` week-columns ending on the
// week of `end` (default "today" in the profile timezone), aligned to the profile's
// first weekday. The query window is derived from the same alignment so no data
// outside the grid is fetched.
//
// `weeks`/`end` are what let the grid honor the Trends hub's shared range (#1492):
// a 90D window draws ~13 columns ending on the window's last day, all time keeps
// the trailing-12-month cap. Callers resolve the column count through
// `fitnessWindowWeeks` (lib/trends-fitness.ts).
export function getWorkoutHeatmap(
  profileId: number,
  weeks = 53,
  endDate?: string
): WorkoutHeatmap {
  const end = endDate ?? today(profileId);
  const weekStart = getWeekStart(profileId);
  const since = heatmapStart(end, weeks, weekStart);
  const density = getWorkoutDayDensity(profileId, since);
  return buildWorkoutHeatmap(density, end, weeks, weekStart);
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
