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
import {
  isDraftActivityRow,
  type DraftCandidateRow,
} from "../../activity-draft";

// Sessions + total training minutes per profile-local day, on/after `since`. ONE
// SQL pass, profile-scoped. `activities.date` is already the profile-local calendar
// day at ingest (issue #94), so grouping by it buckets in the profile timezone.
//
// DRAFTS DO NOT COUNT (#3056), for the same reason the week's own tallies exclude
// them: a create-at-start session that logged nothing is an address, not an entry.
// This gather is what lights the Training Log's and History's active-days strip,
// which sits on the SAME SCREEN as the week caption folded from
// `getTrainingWeekDayTypes` — so a draft counted here would have the Log stating two
// different weeks in two numbers a reader takes in together. The rule is not
// restated in SQL: the query gathers the draft-candidate columns
// `isDraftActivityRow` already reads off a row, and the fold applies THAT function.
// Still ONE prepared statement — the "has any set" half folds onto this SELECT as a
// correlated EXISTS (`idx_sets_activity` serves it), never a per-row set query.
export function getWorkoutDayDensity(
  profileId: number,
  since: string
): WorkoutDayDensity[] {
  const rows = db
    .prepare(
      `SELECT a.date AS date,
              COALESCE(a.duration_min, 0) AS minutes,
              a.start_time, a.end_time, a.duration_min, a.components, a.notes,
              a.distance_km, a.source,
              EXISTS (
                SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
              ) AS has_sets
         FROM activities a
        WHERE a.profile_id = ? AND a.date >= ?
        ORDER BY a.date ASC`
    )
    .all(profileId, since) as (DraftCandidateRow & {
    date: string;
    minutes: number;
    /** 0 or 1 — the draft rule only asks whether ANY set exists (`setCount > 0`). */
    has_sets: number;
  })[];
  const byDate = new Map<string, WorkoutDayDensity>();
  for (const row of rows) {
    if (isDraftActivityRow(row, row.has_sets)) continue;
    const day = byDate.get(row.date);
    if (day) {
      day.count++;
      day.minutes += row.minutes;
    } else {
      byDate.set(row.date, { date: row.date, count: 1, minutes: row.minutes });
    }
  }
  // The grouped SELECT this replaced emitted its days ascending; the fold states
  // that order explicitly rather than inheriting it from SQLite's grouping strategy.
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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

// DRAFTS ARE NOT SESSIONS HERE EITHER (#3191). This is a separate statement from the
// day-density gather above — a different surface with a different consumer, which is
// why #3188 left it alone — but it answers the same question about a row, so it
// answers it the same way. Measured on main: one untouched create-at-start draft
// titled "Push Day" produced a matrix cell reading 1 session, and the positive
// control (a real logged session on the same day) moved it to 2. A draft is titled
// and typed at the moment the session opens, so it lands on a real activity's row in
// the matrix and reads as a session of it.
//
// The rule is not restated in SQL: the draft-candidate columns and the "has any set"
// half (a correlated EXISTS on the same SELECT) ride along, and the fold applies
// `isDraftActivityRow`. Still one prepared statement.
export function getWorkoutActivityDays(
  profileId: number,
  since: string,
  until: string
): WorkoutActivityDay[] {
  const rows = db
    .prepare(
      `SELECT a.date AS date, a.title AS title, a.type AS type,
              a.components AS components,
              COALESCE(a.duration_min, 0) AS minutes,
              a.start_time, a.end_time, a.duration_min, a.notes, a.distance_km,
              a.source,
              EXISTS (
                SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
              ) AS has_sets
         FROM activities a
        WHERE a.profile_id = ? AND a.date >= ? AND a.date <= ?
        ORDER BY a.date ASC, a.id ASC`
    )
    .all(profileId, since, until) as (DraftCandidateRow & {
    date: string;
    title: string;
    type: string;
    components: string | null;
    minutes: number;
    /** 0 or 1 — the draft rule only asks whether ANY set exists (`setCount > 0`). */
    has_sets: number;
  })[];

  const labelByKey = new Map<string, string>();
  const byDayKey = new Map<string, WorkoutActivityDay>();
  for (const r of rows) {
    if (isDraftActivityRow(r, r.has_sets)) continue;
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
