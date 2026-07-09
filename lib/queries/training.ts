import * as React from "react";

// React's per-request cache() exists only in the canary React that Next vendors
// for server components. The plain `react` package that tsx entrypoints
// (scripts/notify.ts, scripts/seed.ts) resolve doesn't export it, so importing
// the named binding crashes the notify sidecar at module load. Fall back to
// identity there: those scripts run each query at most once per tick, so
// per-request dedup is meaningless outside Next anyway.
const cache: typeof React.cache =
  (React as { cache?: typeof React.cache }).cache ?? ((fn) => fn);
import { db, today } from "../db";
import { shiftDateStr, weekdayOfDateStr, startOfWeekStr } from "../date";
import { getWeekStart, getWeekMode } from "../settings";
import type { DistanceUnit, WeightUnit } from "../settings";
import { computeGoalProgress, computeBodyGoalProgress } from "../goal-progress";
import type { GoalProgress, GoalSetRow } from "../goal-progress";
import {
  LIFT_OPTIONS,
  baseLiftName,
  isBodyweight,
  regionForExercise,
  regionsForGroup,
  type BodyGroup,
  type MuscleRegion,
} from "../lifts";
import { goalMatchesExercise } from "../goals";
import { estimate1RM } from "../strength";
import { CARDIO_ACTIVITIES, SPORTS } from "../activities-catalog";
import {
  judgeTargets,
  summarizeExercise,
  type SetStatus,
} from "../journal-format";
import { formatLongDate } from "../format-date";
import { formatMinutes } from "../duration";
import { fmtDistance } from "../units";
import { sessionBestSet, speedKmh } from "../coaching";
import { rankByFrequency } from "../rank-by-frequency";
import { currentStreak } from "../streak";
import { bodyweightAsOf } from "../bodyweight";
import { getLatestBodyMetric } from "./metrics";
import type {
  Activity,
  ActivityComponent,
  BodyMetric,
  BodyMetricKind,
  ExerciseSet,
  FrequencyTarget,
  Goal,
} from "../types";

export interface ActivitySuggestions {
  lifts: string[];
  cardio: string[];
  sports: string[];
}

// Window for the "recent" scans that back the activity picker's suggestions and
// the editor's per-exercise history. Both only need recent data — a name or a
// session older than a year is irrelevant to what to suggest next — so bounding
// the underlying full-table scans to the last 12 months is semantically invisible
// while turning an all-history scan into a small windowed one.
const RECENT_WINDOW_DAYS = 365;

function recentWindowStart(profileId: number): string {
  return shiftDateStr(today(profileId), -RECENT_WINDOW_DAYS);
}

// cache(): the app layout resolves suggestions on every navigation, and a request
// may render this more than once — cache() collapses those to a single scan per
// request (a no-op outside a request, e.g. the notify process, where it just runs).
export const getActivitySuggestions = cache(function getActivitySuggestions(
  profileId: number
): ActivitySuggestions {
  const rawLiftRows = db
    .prepare(
      `SELECT s.exercise AS name, COUNT(*) AS c
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?
       GROUP BY s.exercise`
    )
    .all(profileId, recentWindowStart(profileId)) as {
    name: string;
    c: number;
  }[];
  // Collapse variant names ("Dumbbell Curl") to their base ("Curl") so the
  // picker offers the grouped base and ranks it by combined usage; equipment is
  // then chosen with chips.
  const liftCounts = new Map<string, { name: string; c: number }>();
  for (const r of rawLiftRows) {
    const name = baseLiftName(r.name);
    const key = name.toLowerCase();
    const prev = liftCounts.get(key);
    if (prev) prev.c += r.c;
    else liftCounts.set(key, { name, c: r.c });
  }
  const liftRows = [...liftCounts.values()];
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

// Inclusive start date (YYYY-MM-DD) of a profile's "this week" window: either the
// current calendar week (from the configured week-start day) or a rolling 7-day
// window, per the profile's week_mode. Shared by the weekly-routine counters and
// the journal week summary so the two always agree.
function weekWindowStart(profileId: number): string {
  const t = today(profileId);
  return getWeekMode(profileId) === "rolling"
    ? shiftDateStr(t, -6) // inclusive 7-day window
    : startOfWeekStr(t, getWeekStart(profileId));
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

// ---- Goals ----
export function getGoals(profileId: number): Goal[] {
  // Archived goals sink to the bottom; within each, active before achieved.
  return db
    .prepare(
      `SELECT * FROM goals
       WHERE profile_id = ?
       ORDER BY archived ASC,
                CASE status WHEN 'active' THEN 0 WHEN 'achieved' THEN 1 ELSE 2 END,
                created_at DESC`
    )
    .all(profileId) as Goal[];
}

export type { GoalProgress } from "../goal-progress";

// Auto-derived progress for exercise-linked and body-metric goals. Freeform
// goals (manual) are omitted. One scan over the relevant sets.
export function getGoalProgressMap(
  profileId: number,
  goals: Goal[]
): Map<number, GoalProgress> {
  const out = new Map<number, GoalProgress>();

  // Body-metric goals: latest body-metric value vs baseline → target.
  const bodyGoals = goals.filter((g) => g.body_metric);
  if (bodyGoals.length) {
    const latest: Record<BodyMetricKind, number | null> = {
      weight: getLatestBodyMetric(profileId, "weight"),
      body_fat: getLatestBodyMetric(profileId, "body_fat"),
      resting_hr: getLatestBodyMetric(profileId, "resting_hr"),
    };
    for (const g of bodyGoals) {
      out.set(g.id, computeBodyGoalProgress(g, latest[g.body_metric!]));
    }
  }

  const exGoals = goals.filter((g) => g.exercise && g.metric);
  if (exGoals.length === 0) return out;

  // "Today" in the profile's timezone anchors the trailing recent-form window
  // computeGoalProgress uses to derive `current` (vs the lifetime PR).
  const t = today(profileId);

  // Resolve which exercise NAMES satisfy some goal from the cheap distinct-name
  // list (goal→set matching folds equipment variants to their base — see
  // goalMatchesExercise — which SQL can't express), then load only those sets
  // instead of every set ever. Users routinely log many exercises but set goals
  // on a few, so this skips the bulk of the table.
  const exNames = (
    db
      .prepare(
        `SELECT DISTINCT s.exercise AS exercise
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
         WHERE a.profile_id = ?`
      )
      .all(profileId) as { exercise: string }[]
  ).map((r) => r.exercise);
  const matchingNames = exNames.filter((name) =>
    exGoals.some((g) => goalMatchesExercise(g, name))
  );
  if (matchingNames.length === 0) {
    // Every exGoal still gets an entry (empty progress), matching the old loop.
    for (const g of exGoals) out.set(g.id, computeGoalProgress(g, [], t));
    return out;
  }
  const rows = db
    .prepare(
      `SELECT a.id AS activity_id, a.date AS date, s.exercise AS exercise,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND s.exercise IN (${matchingNames
         .map(() => "?")
         .join(",")})`
    )
    .all(profileId, ...matchingNames) as GoalSetRow[];

  // Index the loaded sets by their (trimmed, lowercased) exercise name once, so
  // each goal gathers its rows by name-key lookup rather than re-scanning the
  // whole array. Keys are deduped per goal so a set can't be double-counted when
  // two spellings of a name both match.
  const byExercise = new Map<string, GoalSetRow[]>();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    const arr = byExercise.get(key);
    if (arr) arr.push(r);
    else byExercise.set(key, [r]);
  }
  for (const g of exGoals) {
    const keys = new Set<string>();
    for (const name of matchingNames)
      if (goalMatchesExercise(g, name)) keys.add(name.trim().toLowerCase());
    const matched: GoalSetRow[] = [];
    for (const k of keys) {
      const arr = byExercise.get(k);
      if (arr) matched.push(...arr);
    }
    out.set(g.id, computeGoalProgress(g, matched, t));
  }
  return out;
}

// ---- Weekly frequency targets ----
export function getFrequencyTargets(profileId: number): FrequencyTarget[] {
  return db
    .prepare(
      "SELECT * FROM frequency_targets WHERE profile_id = ? ORDER BY created_at, id"
    )
    .all(profileId) as FrequencyTarget[];
}

export interface FrequencyTargetProgress {
  target: FrequencyTarget;
  count: number;
  per_week: number;
  met: boolean;
}

// Distinct training days in the profile's weekly window that satisfy each target.
// The window is either the current calendar week (resetting on the week-start day)
// or a rolling 7-day window, per the profile's week_mode. Region/group targets map
// logged exercises -> region in JS (SQL can't); type targets count activities (and
// multi-part components) of that type.
export function getFrequencyTargetProgress(
  profileId: number
): FrequencyTargetProgress[] {
  const targets = getFrequencyTargets(profileId);
  if (targets.length === 0) return [];

  const since = weekWindowStart(profileId);
  const setRows = db
    .prepare(
      `SELECT DISTINCT a.date AS date, s.exercise AS exercise
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND a.date >= ?`
    )
    .all(profileId, since) as { date: string; exercise: string }[];
  const regionDates = new Map<MuscleRegion, Set<string>>();
  for (const r of setRows) {
    const region = regionForExercise(r.exercise);
    if (!region) continue;
    let set = regionDates.get(region);
    if (!set) regionDates.set(region, (set = new Set()));
    set.add(r.date);
  }

  const actRows = db
    .prepare(
      `SELECT date, type, components FROM activities WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, since) as {
    date: string;
    type: string;
    components: string | null;
  }[];
  const typeDates = new Map<string, Set<string>>();
  const addType = (type: string, date: string) => {
    let set = typeDates.get(type);
    if (!set) typeDates.set(type, (set = new Set()));
    set.add(date);
  };
  for (const a of actRows) {
    addType(a.type, a.date);
    if (a.components) {
      try {
        const comps = JSON.parse(a.components) as { type: string }[];
        for (const c of comps) if (c?.type) addType(c.type, a.date);
      } catch {
        // ignore malformed components JSON
      }
    }
  }

  return targets.map((t) => {
    let count = 0;
    if (t.scope_kind === "region") {
      count = regionDates.get(t.scope_value as MuscleRegion)?.size ?? 0;
    } else if (t.scope_kind === "group") {
      const union = new Set<string>();
      for (const reg of regionsForGroup(t.scope_value as BodyGroup))
        for (const d of regionDates.get(reg) ?? []) union.add(d);
      count = union.size;
    } else {
      count = typeDates.get(t.scope_value)?.size ?? 0;
    }
    return { target: t, count, per_week: t.per_week, met: count >= t.per_week };
  });
}

// ---- Strength / exercise history ----

// All dated weights ascending, for bodyweightAsOf lookups. Weightless
// body-metrics rows (HR/body-fat only, #120) are excluded — no bodyweight.
// cache(): both getStrengthByExercise and getRecentExerciseHistory load this, so a
// page rendering both (journal, strength) would otherwise scan the weight history
// twice — cache() collapses it to one scan per profile per request.
const loadWeightsAsc = cache(function loadWeightsAsc(
  profileId: number
): { date: string; weight_kg: number }[] {
  return db
    .prepare(
      "SELECT date, weight_kg FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL ORDER BY date ASC"
    )
    .all(profileId) as { date: string; weight_kg: number }[];
});

export interface RecentSession {
  date: string;
  // The activity this session belongs to (for linking to it in the journal).
  activityId: number;
  // User-defined implement used in the session (first non-null), else null.
  equipment: string | null;
  // Bodyweight to fold into set loads when ranking this session's sets for
  // next-set seeding: the bodyweight as of the session date for catalog
  // bodyweight lifts, 0 otherwise — the same base getStrengthByExercise folds.
  baseKg: number;
  // Hit/missed the declared rep targets (null when none were declared).
  // Judged here so the journal card and editor needn't re-derive it.
  status: SetStatus;
  sets: {
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    // Declared intent (planned reps / AMRAP), shipped so the activity editor
    // can seed next-set suggestions off the newest session.
    target_reps: number | null;
    to_failure: number | null;
  }[];
}
// One exercise's recent history for the activity editor.
export interface ExerciseHistory {
  // Body is (part of) the load: a catalog bodyweight lift, or an exercise
  // never logged with an external weight anywhere in its history. Resolved
  // here (over ALL rows, not just the shipped sessions) so the editor's
  // next-set suggestion classifies exactly like getStrengthByExercise and the
  // exercise detail panel.
  bodyweight: boolean;
  // Most recent sessions, newest first.
  sessions: RecentSession[];
}
// exercise name (lowercased) -> history
export type ExerciseHistoryMap = Record<string, ExerciseHistory>;

// cache(): resolved on every app navigation (the layout's activity editor) and
// again via getRecentByExercise on the journal/strength pages. cache() dedupes to
// one scan per (profile, perExercise) per request. The scan is bounded to the
// recent window — the editor only needs the last few sessions, so a session older
// than 12 months is never shown (and the bodyweight classification below is
// resolved over that same window rather than all-time).
export const getRecentExerciseHistory = cache(function getRecentExerciseHistory(
  profileId: number,
  perExercise = 3
): ExerciseHistoryMap {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right, s.target_reps, s.to_failure,
              eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       WHERE a.profile_id = ? AND a.date >= ?
       ORDER BY a.date DESC, a.id DESC, s.set_number ASC`
    )
    .all(profileId, recentWindowStart(profileId)) as {
    exercise: string;
    date: string;
    activity_id: number;
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    target_reps: number | null;
    to_failure: number | null;
    equipment: string | null;
  }[];

  const weights = loadWeightsAsc(profileId);

  type AccumSession = Omit<RecentSession, "status">;
  interface AccumExercise {
    addBodyweight: boolean; // catalog bodyweight lift
    sawExternalWeight: boolean; // any set in the recent window logged a weight
    sessions: AccumSession[];
  }
  const acc = new Map<string, AccumExercise>();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    let e = acc.get(key);
    if (!e) {
      e = {
        addBodyweight: isBodyweight(r.exercise),
        sawExternalWeight: false,
        sessions: [],
      };
      acc.set(key, e);
    }
    // Tracked across every row in the window — including sessions past the cap
    // below — so the resolved bodyweight flag reflects all recent history, not
    // just the shipped sessions.
    if (r.weight_kg != null || r.weight_kg_right != null)
      e.sawExternalWeight = true;
    let last = e.sessions[e.sessions.length - 1];
    if (!last || last.activityId !== r.activity_id) {
      if (e.sessions.length >= perExercise) continue; // have enough sessions
      last = {
        activityId: r.activity_id,
        date: r.date,
        equipment: null,
        baseKg: e.addBodyweight ? (bodyweightAsOf(weights, r.date) ?? 0) : 0,
        sets: [],
      };
      e.sessions.push(last);
    }
    if (last.equipment == null && r.equipment) last.equipment = r.equipment;
    last.sets.push({
      set_number: r.set_number,
      weight_kg: r.weight_kg,
      reps: r.reps,
      weight_kg_right: r.weight_kg_right,
      reps_right: r.reps_right,
      duration_sec: r.duration_sec,
      duration_sec_right: r.duration_sec_right,
      target_reps: r.target_reps,
      to_failure: r.to_failure,
    });
  }

  const out: ExerciseHistoryMap = {};
  for (const [key, e] of acc) {
    out[key] = {
      bodyweight: e.addBodyweight || !e.sawExternalWeight,
      sessions: e.sessions.map((sess) => ({
        ...sess,
        status: judgeTargets(sess.sets),
      })),
    };
  }
  return out;
});

// One summarized recent session of an exercise, for the exercise detail panel.
// `href` links to the session's activity in the journal; `date`/`text` are
// preformatted so the (client) panel needs no units or formatting.
export interface RecentSessionSummary {
  date: string;
  href: string;
  equipment: string | null;
  text: string;
}
// Recent sessions per exercise, keyed by lowercased exercise name (newest first).
export type RecentByExercise = Record<string, RecentSessionSummary[]>;

// The last `limit` sessions per exercise, summarized and linked to their journal
// entry. Shared by the journal feed and the strength page so both surface the
// same history. Links are absolute so they work from any page.
export function getRecentByExercise(
  profileId: number,
  unit: WeightUnit,
  limit = 10
): RecentByExercise {
  const out: RecentByExercise = {};
  for (const [key, h] of Object.entries(
    getRecentExerciseHistory(profileId, limit)
  )) {
    out[key] = h.sessions.map((s) => ({
      date: formatLongDate(s.date),
      href: `/training?tab=log#activity-${s.activityId}`,
      equipment: s.equipment,
      text: summarizeExercise(s.sets, unit).text,
    }));
  }
  return out;
}

export type ExerciseCompareMetric = "volume" | "e1rm" | "top" | "reps";

export interface ExerciseCompareSession {
  date: string;
  activityId: number;
  equipment: string | null;
  setCount: number;
  totalReps: number;
  volumeKg: number;
  topWeightKg: number | null;
  topReps: number | null;
  e1rmKg: number | null;
  summary: string;
}

// Full per-session history for one exercise, used by the Training comparison
// tab. This keeps the set-level math in the query layer so the page component can
// stay focused on controls and presentation.
export function getExerciseComparison(
  profileId: number,
  exercise: string,
  unit: WeightUnit
): ExerciseCompareSession[] {
  const key = exercise.trim().toLowerCase();
  if (!key) return [];

  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right, s.target_reps, s.to_failure,
              eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       WHERE a.profile_id = ? AND LOWER(TRIM(s.exercise)) = ?
       ORDER BY a.date ASC, a.id ASC, s.set_number ASC`
    )
    .all(profileId, key) as {
    exercise: string;
    date: string;
    activity_id: number;
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    target_reps: number | null;
    to_failure: number | null;
    equipment: string | null;
  }[];

  if (rows.length === 0) return [];

  const addBodyweight = isBodyweight(rows[0].exercise);
  const weights = loadWeightsAsc(profileId);
  const bySession = new Map<
    number,
    {
      date: string;
      activityId: number;
      equipment: string | null;
      rows: typeof rows;
    }
  >();

  for (const r of rows) {
    let session = bySession.get(r.activity_id);
    if (!session) {
      session = {
        date: r.date,
        activityId: r.activity_id,
        equipment: null,
        rows: [],
      };
      bySession.set(r.activity_id, session);
    }
    if (session.equipment == null && r.equipment)
      session.equipment = r.equipment;
    session.rows.push(r);
  }

  return [...bySession.values()].map((s) => {
    const baseKg = addBodyweight ? (bodyweightAsOf(weights, s.date) ?? 0) : 0;
    let totalReps = 0;
    let volumeKg = 0;
    let topWeightKg: number | null = null;
    let topReps: number | null = null;
    let e1rmKg: number | null = null;

    for (const r of s.rows) {
      const sides: { weight: number; reps: number }[] = [];
      if (r.reps != null)
        sides.push({ weight: baseKg + (r.weight_kg ?? 0), reps: r.reps });
      if (r.reps_right != null)
        sides.push({
          weight: baseKg + (r.weight_kg_right ?? 0),
          reps: r.reps_right,
        });

      for (const side of sides) {
        totalReps += side.reps;
        volumeKg += side.weight * side.reps;
        if (topWeightKg == null || side.weight > topWeightKg) {
          topWeightKg = side.weight;
          topReps = side.reps;
        }
        const estimate = estimate1RM(side.weight, side.reps);
        if (
          e1rmKg == null ||
          estimate > e1rmKg ||
          (estimate === e1rmKg && side.reps > (topReps ?? 0))
        ) {
          e1rmKg = estimate;
        }
      }
    }

    return {
      date: s.date,
      activityId: s.activityId,
      equipment: s.equipment,
      setCount: s.rows.length,
      totalReps,
      volumeKg,
      topWeightKg,
      topReps,
      e1rmKg,
      summary: summarizeExercise(s.rows, unit).text,
    };
  });
}

export function getVolumeByDate(profileId: number) {
  return db
    .prepare(
      `SELECT a.date AS date,
              SUM(COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
                  + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)) AS volume
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ?
         AND ((s.weight_kg IS NOT NULL AND s.reps IS NOT NULL)
          OR (s.weight_kg_right IS NOT NULL AND s.reps_right IS NOT NULL))
       GROUP BY a.date ORDER BY a.date ASC`
    )
    .all(profileId) as { date: string; volume: number }[];
}

// Per-exercise strength stats for the combined Strength page: best set,
// Epley estimated 1RM, top weight, session count, and a training-volume
// series over time (one point per session date, ascending).
export interface ExerciseStat {
  exercise: string;
  sessions: number; // distinct dates trained
  totalSets: number;
  topWeightKg: number;
  e1rmKg: number;
  bestWeightKg: number;
  bestReps: number;
  bestDate: string;
  // Date the heaviest load (topWeightKg) was first hit — for PR detection.
  topWeightDate: string;
  lastDate: string;
  // Best working set of the most recent session (highest estimated 1RM, then
  // most reps), used to seed next-set suggestions. Null when the newest session
  // had no usable set. Carries that set's declared intent (planned rep count /
  // AMRAP) so progression can honor the user's rep scheme.
  lastSessionBest: {
    weightKg: number;
    reps: number;
    targetReps: number | null;
    toFailure: boolean;
  } | null;
  // Activity id of the most recent session, for linking to its journal entry.
  lastActivityId: number;
  // Body itself is the load (pull ups, dips), so per-set numbers show "BW".
  // topWeightKg/e1rmKg/bestWeightKg still carry the real load (bodyweight + any
  // added weight) for the volume chart and × bodyweight multiple.
  bodyweight: boolean;
  // The volume series holds total reps (not kg) — true only for bodyweight lifts
  // with no known bodyweight, where weight×reps would be a flat zero.
  volumeIsReps: boolean;
  volume: { date: string; volumeKg: number }[];
}

// cache(): a single Training render aggregates every set 3–4× (Log, Overview,
// Analyze, Strength sections all call this), and the dashboard coaching context
// reads it again — cache() collapses the all-history scan to one per profile per
// request. Safe: it's a pure read, and write actions revalidate rather than
// re-reading in the same request.
export const getStrengthByExercise = cache(function getStrengthByExercise(
  profileId: number
): ExerciseStat[] {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.target_reps, s.to_failure
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       -- Any set with reps, weighted OR bodyweight (bodyweight sets store a
       -- NULL weight); the load is resolved per exercise below.
       WHERE a.profile_id = ? AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
       -- date+id ascending so the last row of an exercise is its newest session.
       ORDER BY a.date ASC, a.id ASC`
    )
    .all(profileId) as {
    exercise: string;
    date: string;
    activity_id: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    target_reps: number | null;
    to_failure: number | null;
  }[];

  const weights = loadWeightsAsc(profileId);
  const bwAsOf = (date: string) => bodyweightAsOf(weights, date);

  interface Acc {
    exercise: string;
    addBodyweight: boolean; // catalog bodyweight lift → fold bodyweight into load
    sawExternalWeight: boolean; // any set logged a weight
    dates: Set<string>;
    totalSets: number;
    topWeightKg: number;
    topWeightDate: string;
    e1rmKg: number;
    bestWeightKg: number;
    bestReps: number;
    bestDate: string;
    lastDate: string;
    lastActivityId: number;
    // Raw rows of the most recent session (same date, across activities),
    // ranked into lastSessionBest by sessionBestSet at the end — the single
    // shared definition of a session's seeding set (lib/coaching).
    lastSessionRows: (typeof rows)[number][];
    volByDate: Map<string, number>;
    repsByDate: Map<string, number>;
  }
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    let cur = map.get(key);
    if (!cur) {
      cur = {
        exercise: r.exercise,
        addBodyweight: isBodyweight(r.exercise),
        sawExternalWeight: false,
        dates: new Set(),
        totalSets: 0,
        topWeightKg: 0,
        topWeightDate: r.date,
        // Sentinel so the first set always seeds the "best" fields, even for
        // bodyweight lifts where every set's estimated 1RM is 0.
        e1rmKg: -1,
        bestWeightKg: 0,
        bestReps: 0,
        bestDate: r.date,
        lastDate: r.date,
        lastActivityId: r.activity_id,
        lastSessionRows: [],
        volByDate: new Map(),
        repsByDate: new Map(),
      };
      map.set(key, cur);
    }
    cur.dates.add(r.date);
    cur.totalSets += 1;
    // Advance the most-recent-session pointer (rows are date+id ascending). On a
    // strictly newer date, reset the per-session row buffer so it reflects only
    // the latest session.
    if (r.date > cur.lastDate) {
      cur.lastDate = r.date;
      cur.lastActivityId = r.activity_id;
      cur.lastSessionRows = [];
    } else if (r.date === cur.lastDate) {
      cur.lastActivityId = r.activity_id; // keep the latest activity id for the day
    }
    cur.lastSessionRows.push(r); // r.date === cur.lastDate after the advance
    if (r.weight_kg != null || r.weight_kg_right != null)
      cur.sawExternalWeight = true;
    // For bodyweight lifts the body is the load: total = bodyweight + any added
    // weight. For everything else the logged weight is the total.
    const base = cur.addBodyweight ? (bwAsOf(r.date) ?? 0) : 0;
    // For per-side sets, evaluate each side as its own candidate so a stronger
    // side isn't hidden; volume below counts both sides. Each side counts only
    // when it has reps.
    const sides: { weight: number; reps: number }[] = [];
    if (r.reps != null)
      sides.push({ weight: base + (r.weight_kg ?? 0), reps: r.reps });
    if (r.reps_right != null)
      sides.push({
        weight: base + (r.weight_kg_right ?? 0),
        reps: r.reps_right,
      });
    let setVol = 0;
    let setReps = 0;
    for (const side of sides) {
      // Strict compare (not Math.max) so topWeightDate records when the heaviest
      // load was *first* reached.
      if (side.weight > cur.topWeightKg) {
        cur.topWeightKg = side.weight;
        cur.topWeightDate = r.date;
      }
      const e1rm = estimate1RM(side.weight, side.reps);
      // Better = higher estimated 1RM; on a tie (e.g. bodyweight lifts), more reps.
      if (
        e1rm > cur.e1rmKg ||
        (e1rm === cur.e1rmKg && side.reps > cur.bestReps)
      ) {
        cur.e1rmKg = e1rm;
        cur.bestWeightKg = side.weight;
        cur.bestReps = side.reps;
        cur.bestDate = r.date;
      }
      setVol += side.weight * side.reps;
      setReps += side.reps;
    }
    cur.volByDate.set(r.date, (cur.volByDate.get(r.date) ?? 0) + setVol);
    cur.repsByDate.set(r.date, (cur.repsByDate.get(r.date) ?? 0) + setReps);
  }

  return [...map.values()]
    .map((c) => {
      // Show "BW" for catalog bodyweight lifts, and for any exercise logged with
      // no weight at all. The chart falls back to reps only when there's no
      // usable load (bodyweight unknown), since weight×reps would be flat zero.
      const bodyweight = c.addBodyweight || !c.sawExternalWeight;
      const volumeIsReps = bodyweight && c.topWeightKg === 0;
      return {
        exercise: c.exercise,
        sessions: c.dates.size,
        totalSets: c.totalSets,
        topWeightKg: c.topWeightKg,
        topWeightDate: c.topWeightDate,
        e1rmKg: Math.max(0, c.e1rmKg),
        bestWeightKg: c.bestWeightKg,
        bestReps: c.bestReps,
        bestDate: c.bestDate,
        lastActivityId: c.lastActivityId,
        // All buffered rows share lastDate, so the bodyweight base is constant.
        lastSessionBest: sessionBestSet(
          c.lastSessionRows,
          c.addBodyweight ? (bwAsOf(c.lastDate) ?? 0) : 0
        ),
        lastDate: c.lastDate,
        bodyweight,
        volumeIsReps,
        volume: [...(volumeIsReps ? c.repsByDate : c.volByDate).entries()]
          .map(([date, volumeKg]) => ({ date, volumeKg }))
          .sort((a, b) => (a.date < b.date ? -1 : 1)),
      };
    })
    .sort((a, b) => b.e1rmKg - a.e1rmKg);
});

// One summarized recent cardio session for the cardio detail panel. `text` is
// preformatted (units applied server-side) so the client panel needs no units.
export interface CardioSessionSummary {
  date: string;
  href: string;
  text: string;
}

// Per-cardio-activity stats for the Training page's Cardio section: totals,
// records (longest distance, fastest avg speed, longest duration) with the date
// each was set, a per-session trend, and the last few sessions. Aggregates
// top-level `cardio` activity rows (mirrors getStrengthByExercise).
export interface CardioStat {
  activity: string;
  sessions: number;
  totalDistanceKm: number;
  totalDurationMin: number;
  longestDistanceKm: number;
  longestDistanceDate: string;
  longestDurationMin: number;
  longestDurationDate: string;
  fastestKmh: number; // 0 when no distance-and-duration session exists
  fastestKmhDate: string;
  hasDistance: boolean;
  lastDate: string;
  lastActivityId: number;
  // One point per session (date ascending) for the trend chart.
  trend: {
    activityId: number;
    date: string;
    distanceKm: number;
    durationMin: number;
    speedKmh: number | null;
  }[];
  recent: CardioSessionSummary[];
}

// One logged cardio/sport effort, identified by its canonical activity name.
// The name comes from the activity's structured component (e.g. "Running"); the
// freeform activity title ("Morning run", "5k run") is NOT used for grouping, so
// the same activity combines across differently-titled sessions. Activities with
// no matching component (legacy/imported rows) fall back to the title + the
// row's own distance/duration.
interface EffortEntry {
  activityId: number;
  date: string;
  name: string;
  distanceKm: number;
  durationMin: number;
  intensity: string | null; // from the activity row (shared by its components)
}
// cache(): a single page can aggregate the same (profile, type) efforts 3–4 times
// per request (getCardioByActivity + getCardioVolumeByWeek + getCardioIntensityMix
// on the training page; + getSportByActivity/journal), each a full activities scan
// with per-row JSON.parse. cache() computes it once per (profile, type[, since])
// per request. Pass `since` (YYYY-MM-DD) to bound the scan — used only by the
// suggestion path, which needs recent names, not all history; the stats
// aggregators call with no `since` so they still see the full record.
const effortEntries = cache(function effortEntries(
  profileId: number,
  targetType: "cardio" | "sport",
  since?: string
): EffortEntry[] {
  const args: (string | number)[] = since
    ? [profileId, targetType, since]
    : [profileId, targetType];
  const rows = db
    .prepare(
      `SELECT id, date, type, title, distance_km, duration_min, intensity, components
       FROM activities
       WHERE profile_id = ? AND (type = ? OR components IS NOT NULL)${
         since ? " AND date >= ?" : ""
       }
       ORDER BY date ASC, id ASC`
    )
    .all(...args) as {
    id: number;
    date: string;
    type: string;
    title: string;
    distance_km: number | null;
    duration_min: number | null;
    intensity: string | null;
    components: string | null;
  }[];

  const out: EffortEntry[] = [];
  for (const r of rows) {
    let comps: ActivityComponent[] = [];
    if (r.components) {
      try {
        const parsed = JSON.parse(r.components);
        if (Array.isArray(parsed)) comps = parsed;
      } catch {
        /* malformed components JSON — fall through to the row-level fallback */
      }
    }
    const matching = comps.filter(
      (c) =>
        c?.type === targetType && typeof c.name === "string" && c.name.trim()
    );
    if (matching.length) {
      for (const c of matching) {
        out.push({
          activityId: r.id,
          date: r.date,
          name: c.name.trim(),
          distanceKm: c.distance_km ?? 0,
          durationMin: c.duration_min ?? 0,
          intensity: r.intensity,
        });
      }
    } else if (r.type === targetType && r.title.trim()) {
      out.push({
        activityId: r.id,
        date: r.date,
        name: r.title.trim(),
        distanceKm: r.distance_km ?? 0,
        durationMin: r.duration_min ?? 0,
        intensity: r.intensity,
      });
    }
  }
  return out;
});

// Previously-logged cardio/sport activity names (canonical, from components),
// with usage counts — for the activity picker's frequency-ranked suggestions.
// Bounded to the recent window: suggestions rank by recent usage, so a name not
// logged in the last 12 months needn't be offered as a prior custom name.
function effortNameCounts(
  profileId: number,
  targetType: "cardio" | "sport"
): { name: string; c: number }[] {
  const counts = new Map<string, { name: string; c: number }>();
  for (const e of effortEntries(
    profileId,
    targetType,
    recentWindowStart(profileId)
  )) {
    const key = e.name.toLowerCase();
    const prev = counts.get(key);
    if (prev) prev.c += 1;
    else counts.set(key, { name: e.name, c: 1 });
  }
  return [...counts.values()];
}

// cache(): like getStrengthByExercise, a single Training render aggregates every
// cardio effort several times (Overview, Analyze, Cardio, Log) and the dashboard
// coaching context reads it again. All callers pass the same (profile, unit) and
// omit recentLimit, so the request-scoped key is stable. Safe: pure read.
export const getCardioByActivity = cache(function getCardioByActivity(
  profileId: number,
  unit: DistanceUnit,
  recentLimit = 10
): CardioStat[] {
  interface Acc extends Omit<CardioStat, "activity"> {
    activity: string;
  }
  const map = new Map<string, Acc>();
  for (const e of effortEntries(profileId, "cardio")) {
    const key = e.name.toLowerCase();
    let cur = map.get(key);
    if (!cur) {
      cur = {
        activity: e.name,
        sessions: 0,
        totalDistanceKm: 0,
        totalDurationMin: 0,
        longestDistanceKm: 0,
        longestDistanceDate: e.date,
        longestDurationMin: 0,
        longestDurationDate: e.date,
        fastestKmh: 0,
        fastestKmhDate: e.date,
        hasDistance: false,
        lastDate: e.date,
        lastActivityId: e.activityId,
        trend: [],
        recent: [],
      };
      map.set(key, cur);
    }
    cur.sessions += 1;
    const dist = e.distanceKm;
    const dur = e.durationMin;
    cur.totalDistanceKm += dist;
    cur.totalDurationMin += dur;
    if (dist > 0) cur.hasDistance = true;
    if (dist > cur.longestDistanceKm) {
      cur.longestDistanceKm = dist;
      cur.longestDistanceDate = e.date;
    }
    if (dur > cur.longestDurationMin) {
      cur.longestDurationMin = dur;
      cur.longestDurationDate = e.date;
    }
    const spd = speedKmh(dist, dur);
    if (spd != null && spd > cur.fastestKmh) {
      cur.fastestKmh = spd;
      cur.fastestKmhDate = e.date;
    }
    if (e.date >= cur.lastDate) {
      cur.lastDate = e.date;
      cur.lastActivityId = e.activityId;
    }
    cur.trend.push({
      activityId: e.activityId,
      date: e.date,
      distanceKm: dist,
      durationMin: dur,
      speedKmh: spd,
    });
    // Newest-first recent list (entries are ascending, so prepend).
    cur.recent.unshift({
      date: formatLongDate(e.date),
      href: `/training?tab=log#activity-${e.activityId}`,
      text:
        dist > 0
          ? `${fmtDistance(dist, unit)} · ${formatMinutes(dur || null)}`
          : formatMinutes(dur || null),
    });
  }

  return [...map.values()]
    .map((c) => ({ ...c, recent: c.recent.slice(0, recentLimit) }))
    .sort(
      (a, b) => b.sessions - a.sessions || (a.activity < b.activity ? -1 : 1)
    );
});

// Distinct, readable colors assigned to cardio activities in the weekly chart.
const CARDIO_PALETTE = [
  "#0ea5e9",
  "#16a34a",
  "#a855f7",
  "#f97316",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#6366f1",
];

export interface CardioWeeklyVolume {
  data: Record<string, number | string>[];
  series: { key: string; label: string; color: string }[];
}

// Weekly cardio training time (minutes), stacked by activity, over the last
// `weeks` weeks that have data. Duration is the universal metric — every cardio
// effort has it (unlike distance), so HIIT/rowing-without-distance are included.
export function getCardioVolumeByWeek(
  profileId: number,
  weeks = 12
): CardioWeeklyVolume {
  const weekStart = getWeekStart(profileId);
  const byWeek = new Map<string, Map<string, number>>();
  const activityTotals = new Map<string, number>();
  for (const e of effortEntries(profileId, "cardio")) {
    const wk = startOfWeekStr(e.date, weekStart);
    let m = byWeek.get(wk);
    if (!m) byWeek.set(wk, (m = new Map()));
    m.set(e.name, (m.get(e.name) ?? 0) + e.durationMin);
    activityTotals.set(
      e.name,
      (activityTotals.get(e.name) ?? 0) + e.durationMin
    );
  }
  // Rank activities by total volume for stable color + legend order.
  const series = [...activityTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name], i) => ({
      key: name,
      label: name,
      color: CARDIO_PALETTE[i % CARDIO_PALETTE.length],
    }));
  const data = [...byWeek.keys()]
    .sort()
    .slice(-weeks)
    .map((wk) => {
      // Full week-start date (the profile's configured first weekday);
      // StackedBarCard compacts the axis to MM-DD and expands the tooltip to a
      // long date.
      const row: Record<string, number | string> = { date: wk };
      const m = byWeek.get(wk)!;
      for (const s of series) row[s.key] = Math.round(m.get(s.key) ?? 0);
      return row;
    });
  return { data, series };
}

export interface IntensityBucket {
  intensity: string; // "Easy" | "Moderate" | "Hard" | "Unspecified"
  minutes: number;
  sessions: number;
}

// Cardio time + session counts grouped by intensity, for the intensity-mix bar.
export function getCardioIntensityMix(profileId: number): IntensityBucket[] {
  const order = ["easy", "moderate", "hard"];
  const buckets = new Map<string, { minutes: number; sessions: number }>();
  for (const e of effortEntries(profileId, "cardio")) {
    const key = (e.intensity ?? "").trim().toLowerCase();
    const norm = order.includes(key) ? key : "unspecified";
    const b = buckets.get(norm) ?? { minutes: 0, sessions: 0 };
    b.minutes += e.durationMin;
    b.sessions += 1;
    buckets.set(norm, b);
  }
  const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  return [...order, "unspecified"]
    .filter((k) => buckets.has(k))
    .map((k) => ({
      intensity: cap(k),
      minutes: Math.round(buckets.get(k)!.minutes),
      sessions: buckets.get(k)!.sessions,
    }));
}

// Per-sport stats for the Training page's Sport explorer + journal detail.
// Sports are duration-only (no distance/speed); tolerates a null duration
// (counts the session, sums/maxes the known durations).
export interface SportStat {
  sport: string;
  sessions: number;
  totalDurationMin: number;
  longestDurationMin: number;
  longestDurationDate: string;
  lastDate: string;
  lastActivityId: number;
  // One point per session (date ascending) for the duration trend chart.
  trend: {
    activityId: number;
    date: string;
    durationMin: number;
    intensity: string | null;
  }[];
  recent: CardioSessionSummary[];
}

export function getSportByActivity(
  profileId: number,
  recentLimit = 10
): SportStat[] {
  const map = new Map<string, SportStat>();
  for (const e of effortEntries(profileId, "sport")) {
    const key = e.name.toLowerCase();
    let cur = map.get(key);
    if (!cur) {
      cur = {
        sport: e.name,
        sessions: 0,
        totalDurationMin: 0,
        longestDurationMin: 0,
        longestDurationDate: e.date,
        lastDate: e.date,
        lastActivityId: e.activityId,
        trend: [],
        recent: [],
      };
      map.set(key, cur);
    }
    cur.sessions += 1;
    const dur = e.durationMin;
    cur.totalDurationMin += dur;
    if (dur > cur.longestDurationMin) {
      cur.longestDurationMin = dur;
      cur.longestDurationDate = e.date;
    }
    if (e.date >= cur.lastDate) {
      cur.lastDate = e.date;
      cur.lastActivityId = e.activityId;
    }
    cur.trend.push({
      activityId: e.activityId,
      date: e.date,
      durationMin: dur,
      intensity: e.intensity,
    });
    // Newest-first recent list (entries are ascending, so prepend).
    cur.recent.unshift({
      date: formatLongDate(e.date),
      href: `/training?tab=log#activity-${e.activityId}`,
      text: formatMinutes(dur || null),
    });
  }

  return [...map.values()]
    .map((s) => ({ ...s, recent: s.recent.slice(0, recentLimit) }))
    .sort((a, b) => b.sessions - a.sessions || (a.sport < b.sport ? -1 : 1));
}

export function getDashboardStats(profileId: number) {
  const activityCount = (
    db
      .prepare("SELECT COUNT(*) c FROM activities WHERE profile_id = ?")
      .get(profileId) as { c: number }
  ).c;
  // Inclusive 7-day window (today + the prior 6 days), matching the journal week
  // summary. -7 would span 8 days.
  const last7 = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND date >= ?"
      )
      .get(profileId, shiftDateStr(today(profileId), -6)) as { c: number }
  ).c;
  // Latest row that actually carries a weight (weightless HR/body-fat rows are
  // skipped, #120). Tie-break same-date rows by id so the newest wins (matches
  // getLatestBodyMetric).
  const latestWeight = db
    .prepare(
      "SELECT * FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1"
    )
    .get(profileId) as BodyMetric | undefined;
  const activeGoals = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM goals WHERE profile_id = ? AND status = 'active' AND archived = 0"
      )
      .get(profileId) as { c: number }
  ).c;
  return { activityCount, last7, latestWeight, activeGoals };
}
