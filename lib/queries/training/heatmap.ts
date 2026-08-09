// Workout-density heatmap — DB read layer (issue #186). One profile-scoped grouped
// pass over `activities` (sessions + total minutes per day), assembled into the
// trailing-12-month grid by the pure builder in lib/workout-heatmap. Distinct from
// the sidebar calendar's `getActivityDates` (which spans ALL activity kinds) — this
// is workout-specific and carries per-day counts/minutes, not just a date set.
import { db, today } from "../../db";
import { getWeekStart } from "../../settings";
import type { ActivityType } from "../../types";
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
