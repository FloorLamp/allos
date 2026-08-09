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
// Day / Pull Day / Cycling, not the coarse strength/cardio buckets).
//
// Identity, in order:
//   1. A cardio/sport row's SOLE component names the activity itself
//      ("Cycling", "Pickleball") — the same component identity the cardio
//      analytics key on, and a far better one than a freeform provider title
//      (a Strava ride is titled "Pizza Hut", not "Cycling"). A STRENGTH row's
//      components are its EXERCISES, never the activity, so strength never
//      takes this path.
//   2. Otherwise `activityHistoryKey(workoutActivityLabel(title))` — the
//      #1931 canonical activity key over the title normalized of its
//      time-of-day/duration decoration — so "Push day", "Afternoon Push Day"
//      and "Morning Push Day Session" land on ONE row.
// The label is the first-seen form for the key.
export interface WorkoutActivityDay {
  date: string; // YYYY-MM-DD, profile-local
  key: string; // activityHistoryKey of the resolved activity name
  label: string; // display name (first-seen resolved form)
  count: number; // sessions of this activity that day
  minutes: number; // total minutes (0 when all durations null)
}

function soleComponentActivity(
  type: string,
  componentsJson: string | null
): string | null {
  if (type === "strength" || !componentsJson) return null;
  try {
    const parts = JSON.parse(componentsJson) as { name?: unknown }[];
    if (
      Array.isArray(parts) &&
      parts.length === 1 &&
      typeof parts[0]?.name === "string" &&
      parts[0].name.trim()
    ) {
      return parts[0].name.trim();
    }
  } catch {
    // Malformed JSON → fall through to the title identity.
  }
  return null;
}

export function getWorkoutActivityDays(
  profileId: number,
  since: string,
  until: string
): WorkoutActivityDay[] {
  const rows = db
    .prepare(
      `SELECT date, title, type, components, COALESCE(duration_min, 0) AS minutes
         FROM activities
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, since, until) as {
    date: string;
    title: string;
    type: string;
    components: string | null;
    minutes: number;
  }[];

  const labelByKey = new Map<string, string>();
  const byDayKey = new Map<string, WorkoutActivityDay>();
  for (const r of rows) {
    const label =
      soleComponentActivity(r.type, r.components) ??
      workoutActivityLabel(r.title);
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
