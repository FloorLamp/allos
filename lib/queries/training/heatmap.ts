// Workout day-density — DB read layer (issue #186). Profile-scoped grouped passes
// over `activities` (sessions + total minutes per day, and per day AND type for
// the Trends day-history). Distinct from the sidebar calendar's
// `getActivityDates` (which spans ALL activity kinds) — this is workout-specific
// and carries per-day counts/minutes, not just a date set.
import { db, today } from "../../db";
import { workoutActivityLabel } from "../../activity-meta";
import { activityHistoryKey } from "../../activities-catalog";
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

// Sessions + minutes per profile-local day AND named activity, in
// [since, until] — the gather behind the Trends → Fitness workout day-history
// matrix ("top N activities", the owner's PPL-breakdown ask: rows like Push
// Day / Pull Day / Ride, not the coarse strength/cardio buckets). Identity is
// `activityHistoryKey(workoutActivityLabel(title))` — the #1931 canonical
// activity key over the title normalized of its time-of-day/duration
// decoration — so "Push day", "Afternoon Push Day" and "Morning Push Day
// Session" land on ONE row. The label is the first-seen normalized form.
export interface WorkoutActivityDay {
  date: string; // YYYY-MM-DD, profile-local
  key: string; // activityHistoryKey of the normalized title
  label: string; // display name (first-seen normalized title)
  count: number; // sessions of this activity that day
  minutes: number; // total minutes (0 when all durations null)
}

export function getWorkoutActivityDays(
  profileId: number,
  since: string,
  until: string
): WorkoutActivityDay[] {
  const rows = db
    .prepare(
      `SELECT date, title, COALESCE(duration_min, 0) AS minutes
         FROM activities
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, since, until) as {
    date: string;
    title: string;
    minutes: number;
  }[];

  const labelByKey = new Map<string, string>();
  const byDayKey = new Map<string, WorkoutActivityDay>();
  for (const r of rows) {
    const label = workoutActivityLabel(r.title);
    const key = activityHistoryKey(label);
    if (!labelByKey.has(key)) labelByKey.set(key, label);
    const mapKey = `${r.date}|${key}`;
    const entry = byDayKey.get(mapKey);
    if (entry) {
      entry.count += 1;
      entry.minutes += r.minutes;
    } else {
      byDayKey.set(mapKey, {
        date: r.date,
        key,
        label: labelByKey.get(key)!,
        count: 1,
        minutes: r.minutes,
      });
    }
  }
  return [...byDayKey.values()];
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
