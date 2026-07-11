import { CARDIO_ACTIVITIES, SPORTS } from "../../activities-catalog";
import {
  buildCompanionMap,
  type CompanionMap,
  type CompanionRow,
} from "../../companions";
import { shiftDateStr, weekdayOfDateStr } from "../../date";
import { db, today } from "../../db";
import { decayedWeight } from "../../decay";
import { LIFT_OPTIONS, baseLiftName } from "../../lifts";
import { rankByFrequency } from "../../rank-by-frequency";
import { currentStreak } from "../../streak";
import type { Activity, ExerciseSet } from "../../types";
import { getLatestBodyMetricDated } from "../metrics";
import {
  cache,
  effortNameCounts,
  recentWindowStart,
  weekWindowStart,
} from "./common";

export interface ActivitySuggestions {
  lifts: string[];
  cardio: string[];
  sports: string[];
  // Per-lift co-occurrence: base-name (lowercased) -> top co-logged lifts, used
  // to bias the combobox toward companions of the draft's exercises (issue #195).
  liftCompanions: CompanionMap;
}

// cache(): the app layout resolves suggestions on every navigation, and a request
// may render this more than once — cache() collapses those to a single scan per
// request (a no-op outside a request, e.g. the notify process, where it just runs).
export const getActivitySuggestions = cache(function getActivitySuggestions(
  profileId: number
): ActivitySuggestions {
  const t = today(profileId);
  const since = recentWindowStart(profileId);
  // Per-name × date rows so each occurrence can be recency-weighted (issue #195):
  // a set logged today counts 1.0, ~60 days ago 0.5, so a recent habit outranks
  // a stale one. Still bounded to the 12-month recent window.
  const rawLiftRows = db
    .prepare(
      `SELECT s.exercise AS name, a.date AS date, COUNT(*) AS c
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       GROUP BY s.exercise, a.date`
    )
    .all(profileId, since) as {
    name: string;
    date: string;
    c: number;
  }[];
  // Collapse variant names ("Dumbbell Curl") to their base ("Curl") so the
  // picker offers the grouped base and ranks it by combined (decayed) usage;
  // equipment is then chosen with chips.
  const liftCounts = new Map<string, { name: string; c: number }>();
  for (const r of rawLiftRows) {
    const name = baseLiftName(r.name);
    const key = name.toLowerCase();
    const w = r.c * decayedWeight(r.date, t);
    const prev = liftCounts.get(key);
    if (prev) prev.c += w;
    else liftCounts.set(key, { name, c: w });
  }
  const liftRows = [...liftCounts.values()];

  // Co-occurrence: the distinct exercises per activity (one row each), fed to
  // the pure companion builder (base-collapsed, decayed, top-5 capped). The
  // GROUP BY makes each (activity, exercise) distinct, so set multiplicity
  // doesn't inflate a pairing. Profile-scoped via the activities join.
  const companionRows = db
    .prepare(
      `SELECT s.activity_id AS activityId, a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       GROUP BY s.activity_id, s.exercise`
    )
    .all(profileId, since) as CompanionRow[];

  // Cardio/sport names come from the structured component names ("Running"), not
  // the freeform activity title ("Morning run"), so the picker suggests real
  // activity names rather than one-off session labels.
  return {
    lifts: rankByFrequency(LIFT_OPTIONS, liftRows),
    cardio: rankByFrequency(
      CARDIO_ACTIVITIES,
      effortNameCounts(profileId, "cardio")
    ),
    sports: rankByFrequency(SPORTS, effortNameCounts(profileId, "sport")),
    liftCompanions: buildCompanionMap(companionRows, t),
  };
});

// ---- Activities / Journal ----
// Omit `limit` to fetch the full history (the journal pages all activities
// client-side); pass a number to cap the result (e.g. dashboard previews).
export function getActivities(profileId: number, limit?: number): Activity[] {
  if (limit == null) {
    return db
      .prepare(
        "SELECT * FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC"
      )
      .all(profileId) as Activity[];
  }
  return db
    .prepare(
      "SELECT * FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC LIMIT ?"
    )
    .all(profileId, limit) as Activity[];
}

export interface JournalWeekSummary {
  sessions: number; // activities logged in the profile's weekly window
  activeDays: number; // distinct days trained in the profile's weekly window
  volumeKg: number; // total weight × reps (both sides) in the profile's weekly window
  streak: number; // consecutive active days ending today (or yesterday)
}

export function getJournalWeekSummary(profileId: number): JournalWeekSummary {
  // "This week" per the profile's setting: the current calendar week (resetting
  // on the week-start day) or a rolling 7-day window.
  const since = weekWindowStart(profileId);
  const sessions = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND date >= ?`
      )
      .get(profileId, since) as { c: number }
  ).c;
  const activeDays = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT date) c FROM activities WHERE profile_id = ? AND date >= ?`
      )
      .get(profileId, since) as { c: number }
  ).c;
  const volumeKg = (
    db
      .prepare(
        `SELECT COALESCE(SUM(
            COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
          + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)), 0) v
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
         WHERE a.profile_id = ? AND a.date >= ?`
      )
      .get(profileId, since) as { v: number }
  ).v;
  return {
    sessions,
    activeDays,
    volumeKg,
    streak: currentStreak(today(profileId), getActivityDates(profileId)),
  };
}

export function getActivitiesByDate(
  profileId: number,
  date: string
): Activity[] {
  return db
    .prepare(
      "SELECT * FROM activities WHERE profile_id = ? AND date = ? ORDER BY id DESC"
    )
    .all(profileId, date) as Activity[];
}

export function getActivityDates(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT DISTINCT date FROM activities WHERE profile_id = ? ORDER BY date DESC"
      )
      .all(profileId) as { date: string }[]
  ).map((r) => r.date);
}

export interface InferredWorkoutSchedule {
  weekdays: number[]; // 0=Sun … 6=Sat the user habitually trains
  hour: number; // typical start hour (local), fallback 18
}

// Derive the user's regular training cadence from recent history, so the workout
// reminder fires around when they normally train: the weekdays trained on often
// enough, and the most common start hour. Falls back to every day at 18:00 when
// there's no clear pattern.
export function inferWorkoutSchedule(
  profileId: number,
  weeks = 8
): InferredWorkoutSchedule {
  const rows = db
    .prepare(
      `SELECT date, start_time FROM activities WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, shiftDateStr(today(profileId), -weeks * 7)) as {
    date: string;
    start_time: string | null;
  }[];

  const datesByWeekday = new Map<number, Set<string>>();
  const hourCounts = new Map<number, number>();
  for (const r of rows) {
    const wd = weekdayOfDateStr(r.date);
    let set = datesByWeekday.get(wd);
    if (!set) datesByWeekday.set(wd, (set = new Set()));
    set.add(r.date);
    if (r.start_time) {
      const h = Number(r.start_time.slice(0, 2));
      if (Number.isInteger(h) && h >= 0 && h <= 23)
        hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
    }
  }

  // Most common start hour; fallback 18 when start times are absent.
  let hour = 18;
  let best = 0;
  for (const [h, c] of hourCounts) if (c > best) ((best = c), (hour = h));

  // A weekday counts as habitual when trained on it in ≥ this many distinct
  // dates within the window.
  const minDates = Math.max(2, Math.ceil(weeks * 0.4));
  const weekdays = [...datesByWeekday.entries()]
    .filter(([, dates]) => dates.size >= minDates)
    .map(([wd]) => wd)
    .sort((a, b) => a - b);

  if (weekdays.length === 0) return { weekdays: [0, 1, 2, 3, 4, 5, 6], hour };
  return { weekdays, hour };
}

// (date, exercise) rows over the recent window — one scan that powers the workout
// recommendation (yesterday's regions, the per-weekday pattern, exercise frequency).
export function getRecentDatedExercises(
  profileId: number,
  days = 56
): { date: string; exercise: string }[] {
  return db
    .prepare(
      `SELECT a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       ORDER BY a.date DESC`
    )
    .all(profileId, shiftDateStr(today(profileId), -days)) as {
    date: string;
    exercise: string;
  }[];
}

// Sets belong to a profile only through their parent activity, so the ids (which
// arrive from forms) are filtered via a join on activities.profile_id — a set id
// from another profile is silently dropped rather than trusted.
export function getSetsForActivities(
  profileId: number,
  ids: number[]
): ExerciseSet[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.* FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND s.activity_id IN (${placeholders})
       ORDER BY s.exercise, s.set_number`
    )
    .all(profileId, ...ids) as ExerciseSet[];
}

export function getDashboardStats(profileId: number) {
  const activityCount = (
    db
      .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
      .get(profileId) as { c: number }
  ).c;
  // Hard rolling 7-day window (today + the prior 6 days) behind the "Activities
  // (7d)" tile. This is intentionally NOT the journal week summary, which is now
  // week_mode-aware (lib/week-window.ts, #223) — the tile's label says "7d", so
  // keep the fixed window and don't "align" the two.
  const last7 = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND date >= ?"
      )
      .get(profileId, shiftDateStr(today(profileId), -6)) as { c: number }
  ).c;
  // Current weight routed through the canonical reconciled reader so it honors the
  // profile's primary-source priority (#14) — the same value the passport, goals,
  // and strength bodyweight calcs show. A raw newest-row query here silently
  // disagreed with every other "current weight" surface (#302); one question, one
  // computation.
  const latestWeight = getLatestBodyMetricDated(profileId, "weight");
  const activeGoals = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM goals WHERE profile_id = ? AND status = 'active' AND archived = 0"
      )
      .get(profileId) as { c: number }
  ).c;
  return { activityCount, last7, latestWeight, activeGoals };
}
