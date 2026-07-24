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
import {
  rankByFrequency,
  prioritizeRoutineSlots,
} from "../../rank-by-frequency";
import { getActiveRoutine } from "../../routines";
import { resolveTodayRoutineDayIndex } from "../../workout-recommendation";
import { currentStreak } from "../../streak";
import type { ActivityEditData } from "../../activity-form-model";
import { pickImportedActivityMetrics } from "../../activity-import-details";
import type { Activity, ActivityType, ExerciseSet } from "../../types";
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

// The base-collapsed exercise names prescribed by TODAY'S resolved routine day (#1115
// Fix C): every candidate of every slot on the day the rotation cursor points at,
// de-duplicated in slot order. Base-collapsed (baseLiftName) so they line up with the
// picker's grouped base names. Empty when there's no active routine / no days — the
// picker then keeps its plain frequency order. Reuses the SAME resolveTodayRoutineDayIndex
// the recommendation core and crediting path share (#831), so "today's day" can't fork.
function todayRoutineSlotNames(profileId: number): string[] {
  const routine = getActiveRoutine(profileId);
  if (!routine) return [];
  const idx = resolveTodayRoutineDayIndex({
    position: routine.position,
    days: routine.days,
  });
  if (idx === null) return [];
  const day = routine.days[idx];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const slot of day.slots) {
    for (const cand of slot.candidates) {
      const base = baseLiftName(cand);
      const key = base.toLowerCase();
      if (base && !seen.has(key)) {
        seen.add(key);
        names.push(base);
      }
    }
  }
  return names;
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

  // Routine-aware picker order (#1115 Fix C): when an active routine resolves a day for
  // today, its prescribed slot exercises (+ their candidates) float to the FRONT of the
  // frequency-ranked lift list, so logging the session you're actually doing is a tap,
  // not a scroll. Off a routine, `routineSlotNames` is empty and the order is
  // byte-for-byte the frequency ranking. Names are base-collapsed to match the picker's
  // grouped base names. One more consumer of the already-resolved routine.
  const routineSlotNames = todayRoutineSlotNames(profileId);

  // Cardio/sport names come from the structured component names ("Running"), not
  // the freeform activity title ("Morning run"), so the picker suggests real
  // activity names rather than one-off session labels.
  return {
    lifts: prioritizeRoutineSlots(
      rankByFrequency(LIFT_OPTIONS, liftRows),
      routineSlotNames
    ),
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

// The profile's session gear, most-recently-used first (issues #342/#339), used to
// DEFAULT the activity-level equipment picker on a new log — the same "last-used"
// convenience the strength implement picker has. Returns a de-duplicated, recency-
// ordered list of every equipment id linked to a past activity; the form's pure
// pickDefaultActivityEquipment then takes the first id that's a valid candidate for
// the CURRENT activity, so a run defaults to the last-used shoes and a ride to the
// last-used bike (the candidate set is narrowed per-activity — issue #339), each
// remembering its own gear rather than sharing one per-type slot. Profile-scoped.
export function getRecentActivityEquipmentIds(profileId: number): number[] {
  const rows = db
    .prepare(
      `SELECT equipment_id FROM activities
        WHERE profile_id = ? AND equipment_id IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as { equipment_id: number }[];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (!seen.has(r.equipment_id)) {
      seen.add(r.equipment_id);
      out.push(r.equipment_id);
    }
  }
  return out;
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

// Activities on or after `since` (YYYY-MM-DD, inclusive), newest first. The bounded
// counterpart to getActivities() for callers that only reduce a trailing window and
// don't need full history — e.g. the weekly recap's two 7-day windows (issue #389),
// which otherwise loaded every activity (SELECT *, including the components TEXT) to
// discard all but ~14 days. Streak math that DOES need full history uses the cheap
// getActivityDates instead.
export function getActivitiesSince(
  profileId: number,
  since: string
): Activity[] {
  return db
    .prepare(
      "SELECT * FROM activities WHERE profile_id = ? AND date >= ? ORDER BY date DESC, id DESC"
    )
    .all(profileId, since) as Activity[];
}

// One page of the Journal feed, windowed SERVER-SIDE by whole days (issue #451). The
// journal is browsed by recency, so paging by day (not by row) keeps a day's cards
// intact — a page never splits a single day across the boundary, so the client can
// append pages by plain concatenation. Keyset ("seek") pagination on `date`: pass the
// previous page's `nextBefore` as `before` to get the next-older window; null starts
// at the newest day. Bounded — at most `dayLimit` days' activities cross the wire per
// call, instead of the profile's entire history (SELECT *, incl. the components TEXT)
// on every visit. `nextBefore` is the oldest loaded date when more days remain (an
// over-fetch of one extra date decides this without a phantom trailing page), else
// null. Profile-scoped on both statements.
export interface JournalPage {
  activities: Activity[]; // every activity on the returned days, date DESC, id DESC
  days: string[]; // the distinct dates covered, date DESC
  nextBefore: string | null; // cursor for the next-older page, or null when exhausted
}

export function getJournalPage(
  profileId: number,
  before: string | null,
  dayLimit: number
): JournalPage {
  const limit = Math.max(1, dayLimit);
  // Over-fetch one extra date so we can tell whether an older page exists without
  // issuing a separate count (or a trailing page that comes back empty).
  const dateRows = (
    before == null
      ? db.prepare(
          `SELECT DISTINCT date FROM activities WHERE profile_id = ?
             ORDER BY date DESC LIMIT ?`
        )
      : db.prepare(
          `SELECT DISTINCT date FROM activities WHERE profile_id = ? AND date < ?
             ORDER BY date DESC LIMIT ?`
        )
  ).all(
    ...(before == null
      ? [profileId, limit + 1]
      : [profileId, before, limit + 1])
  ) as {
    date: string;
  }[];

  const hasMore = dateRows.length > limit;
  const days = dateRows.slice(0, limit).map((r) => r.date);
  if (days.length === 0) return { activities: [], days: [], nextBefore: null };

  const placeholders = days.map(() => "?").join(",");
  const activities = db
    .prepare(
      `SELECT * FROM activities WHERE profile_id = ? AND date IN (${placeholders})
         ORDER BY date DESC, id DESC`
    )
    .all(profileId, ...days) as Activity[];

  return {
    activities,
    days,
    nextBefore: hasMore ? days[days.length - 1] : null,
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
  // Whether a real training cadence was detected. false means `weekdays` is the
  // "every day" fallback (no discernible pattern), so consumers that need to know
  // "is TODAY specifically a predicted training day?" must treat it as unknown
  // rather than "yes, every day" (see isPredictedWorkoutDay / issue #558).
  hasPattern: boolean;
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

  if (weekdays.length === 0)
    return { weekdays: [0, 1, 2, 3, 4, 5, 6], hour, hasPattern: false };
  return { weekdays, hour, hasPattern: true };
}

// Whether `date` should be a training day for this profile, per the inferred
// cadence (issue #558). Returns `null` when no cadence can be inferred — the
// caller then falls back to "was a workout actually logged" rather than guessing.
// This is the "today SHOULD be a workout day" signal a pre-workout supplement
// reminder needs (so it can fire in the morning, before the session), reusing the
// same inferWorkoutSchedule the notify tick's workout reminder consumes ("one
// question, one computation").
export function isPredictedWorkoutDay(
  profileId: number,
  date: string,
  weeks = 8
): boolean | null {
  const inf = inferWorkoutSchedule(profileId, weeks);
  if (!inf.hasPattern) return null;
  return inf.weekdays.includes(weekdayOfDateStr(date));
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

// The encoded GPS route polyline for each of `ids` that has one (issue #569),
// returned as activityId -> polyline. Profile-scoped through the activities JOIN
// (activity_routes carries no profile_id of its own). Feeds the Journal card's
// tile-free SVG route thumbnail; only activities with a captured route appear.
export function getRoutePolylinesForActivities(
  profileId: number,
  ids: number[]
): Map<number, string> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT r.activity_id, r.polyline
         FROM activity_routes r JOIN activities a ON a.id = r.activity_id
        WHERE a.profile_id = ? AND r.activity_id IN (${placeholders})`
    )
    .all(profileId, ...ids) as { activity_id: number; polyline: string }[];
  return new Map(rows.map((r) => [r.activity_id, r.polyline]));
}

// Device active energy is stored as a metric_sample rather than on activities.
// New samples carry the activity's stable provider identity, so user edits to
// date/clock fields and profile timezone changes cannot break the association.
// The window matcher below remains only for pre-migration samples that have not
// yet been backfilled or seen in a provider re-sync.
export function getActiveCaloriesForActivities(
  profileId: number,
  activities: Activity[]
): Map<number, number> {
  const linkedCandidates = activities.filter(
    (activity) => activity.source && activity.external_id
  );
  const linked = new Map<number, number>();
  if (linkedCandidates.length > 0) {
    const externalIds = [
      ...new Set(linkedCandidates.map((activity) => activity.external_id!)),
    ];
    const placeholders = externalIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT source, activity_external_id, value
           FROM metric_samples
          WHERE profile_id = ? AND metric = 'active_kcal'
            AND activity_external_id IN (${placeholders})`
      )
      .all(profileId, ...externalIds) as {
      source: string;
      activity_external_id: string;
      value: number;
    }[];
    const byIdentity = new Map(
      rows.map((row) => [
        `${row.source}\0${row.activity_external_id}`,
        row.value,
      ])
    );
    for (const activity of linkedCandidates) {
      const value = byIdentity.get(
        `${activity.source!}\0${activity.external_id!}`
      );
      if (value != null) linked.set(activity.id, value);
    }
  }

  const legacyCandidates = activities.filter(
    (activity) =>
      !linked.has(activity.id) &&
      activity.source === "strava" &&
      activity.start_time &&
      activity.end_time
  );
  if (legacyCandidates.length === 0) return linked;
  const dates = legacyCandidates.map((activity) => activity.date).sort();
  const rows = db
    .prepare(
      `SELECT source, date, start_time, end_time, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'active_kcal'
          AND source = 'strava'
          AND activity_external_id IS NULL
          AND date BETWEEN ? AND ?`
    )
    .all(profileId, dates[0], dates[dates.length - 1]) as {
    source: string;
    date: string;
    start_time: string;
    end_time: string;
    value: number;
  }[];
  const storedClock = (value: string): string =>
    /T(\d{2}:\d{2})/.exec(value)?.[1] ?? value.slice(0, 5);
  // Only Strava has a safe window fallback: its old sample timestamps encode the
  // same local wall-clock numerals stored on the activity. Health Connect and Oura
  // legacy rows are linked by migration 035; projecting their remaining null-link
  // instants through the profile's mutable timezone would recreate the bug this
  // stable identity column fixes.
  const sampleKey = (
    source: string,
    date: string,
    start: string,
    end: string
  ): string => `${source}\0${date}\0${storedClock(start)}\0${storedClock(end)}`;
  const activityKey = (
    source: string,
    date: string,
    start: string,
    end: string
  ): string => `${source}\0${date}\0${storedClock(start)}\0${storedClock(end)}`;
  const byWindow = new Map(
    rows.map((row) => [
      sampleKey(row.source, row.date, row.start_time, row.end_time),
      row.value,
    ])
  );
  for (const activity of legacyCandidates) {
    const value = byWindow.get(
      activityKey(
        activity.source!,
        activity.date,
        activity.start_time!,
        activity.end_time!
      )
    );
    if (value != null) linked.set(activity.id, value);
  }
  return linked;
}

// The single most recent activity as an ActivityEditData (issue #337): the seed
// for a "Repeat last activity" command palette entry / mobile quick action, so
// repeat-last isn't desktop-only. Newest by (date, id); null when nothing is
// logged. Profile-scoped; its sets come through getSetsForActivities (also
// scoped). Mirrors buildJournalCards' editData mapping so the repeated draft is
// identical whichever surface launched it.
// Map an activity row (+ its scoped sets) to the ActivityEditData the editor
// consumes. Shared by getMostRecentActivityEditData and getActivityEditData so a
// repeated/resumed draft is identical whichever surface launched it.
function activityToEditData(profileId: number, a: Activity): ActivityEditData {
  const sets = getSetsForActivities(profileId, [a.id]);
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    date: a.date,
    duration_min: a.duration_min,
    elapsed_min: a.elapsed_min,
    distance_km: a.distance_km,
    intensity: a.intensity,
    start_time: a.start_time,
    end_time: a.end_time,
    components: a.components,
    notes: a.notes,
    source: a.source,
    edited: a.edited,
    created_at: a.created_at,
    updated_at: a.updated_at,
    est_calories: a.est_calories,
    equipment_id: a.equipment_id,
    imported_metrics: pickImportedActivityMetrics(a),
    sets: sets.map((s) => ({
      exercise: s.exercise,
      set_number: s.set_number,
      weight_kg: s.weight_kg,
      reps: s.reps,
      weight_kg_right: s.weight_kg_right,
      reps_right: s.reps_right,
      duration_sec: s.duration_sec,
      duration_sec_right: s.duration_sec_right,
      equipment_id: s.equipment_id,
      target_reps: s.target_reps,
      to_failure: s.to_failure,
      warmup: s.warmup,
      rpe: s.rpe,
    })),
  };
}

export function getMostRecentActivityEditData(
  profileId: number
): ActivityEditData | null {
  const a = db
    .prepare(
      `SELECT * FROM activities WHERE profile_id = ?
        ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId) as Activity | undefined;
  return a ? activityToEditData(profileId, a) : null;
}

// The ActivityEditData for a specific activity (#921) — the workout dock reopens a
// live session by id, hydrated from the persisted #451 draft. Profile-scoped;
// null when the id isn't this profile's.
export function getActivityEditData(
  profileId: number,
  activityId: number
): ActivityEditData | null {
  const a = db
    .prepare(`SELECT * FROM activities WHERE id = ? AND profile_id = ?`)
    .get(activityId, profileId) as Activity | undefined;
  return a ? activityToEditData(profileId, a) : null;
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
