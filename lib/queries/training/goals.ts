import { db, today } from "../../db";
import type { GoalProgress, GoalSetRow } from "../../goal-progress";
import {
  computeBodyGoalProgress,
  computeGoalProgress,
} from "../../goal-progress";
import { goalMatchesExercise, frequencyPace } from "../../goals";
import type { FrequencyPace } from "../../goals";
import { daysBetweenDateStr } from "../../date";
import type { BodyGroup, MuscleRegion } from "../../lifts";
import { regionForExercise, regionsForGroup } from "../../lifts";
import type { BodyMetricKind, FrequencyTarget, Goal } from "../../types";
import { parseComponents } from "../../types";
import { getLatestBodyMetric } from "../metrics";
import {
  mobilityRegionDays,
  type MobilitySessionInput,
} from "../../mobility-coverage";
import { weekWindowStart } from "./common";

// ---- Goals ----
export function getGoals(profileId: number): Goal[] {
  // Archived goals sink to the bottom; within each, active before achieved.
  // status is exactly ('active' | 'achieved') (GoalStatus / migration 016 CHECK),
  // so the CASE covers the whole set — 'active' first, everything else (achieved)
  // after; there is no dead third arm.
  return db
    .prepare(
      `SELECT * FROM goals
       WHERE profile_id = ?
       ORDER BY archived ASC,
                CASE status WHEN 'active' THEN 0 ELSE 1 END,
                created_at DESC`
    )
    .all(profileId) as Goal[];
}

export type { GoalProgress } from "../../goal-progress";

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
       WHERE a.profile_id = ? AND s.warmup = 0 AND s.exercise IN (${matchingNames
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
  // Paced status (#748 item 3): "met" once complete, "on-pace" while keeping up with the
  // share of the week elapsed, else "behind". Computed once here so every surface agrees.
  pace: FrequencyPace;
}

// Distinct training days in the profile's weekly window that satisfy each target.
// The window is either the current calendar week (resetting on the week-start day)
// or a rolling 7-day window, per the profile's week_mode. Region/group targets map
// logged exercises -> region in JS (SQL can't); type targets count activities (and
// multi-part components) of that type.
export function getFrequencyTargetProgress(
  profileId: number
): FrequencyTargetProgress[] {
  // Substance reduction targets (#998) are deliberately EXCLUDED here: their
  // per_week is a weekly CAP (a ceiling), the inverse of every other scope's
  // floor, so a floor-semantics reader (this rollup, the digest's goals-due
  // list, the Upcoming unmet-target generator, the presence recap) would render
  // "2 of 7 — 5 to go", nudging toward MORE consumption. Their progress is the
  // dedicated lib/queries/substance.ts read over the SAME table.
  const targets = getFrequencyTargets(profileId).filter(
    (t) => t.scope_kind !== "substance"
  );
  if (targets.length === 0) return [];

  const since = weekWindowStart(profileId);
  // Days elapsed in this week's window through today, inclusive (1..7) — the pacing
  // denominator (#748 item 3). Rolling mode's window is always the trailing 7 days, so
  // this is 7 there; calendar mode grows it from 1 on the week-start day.
  const elapsedDays = (daysBetweenDateStr(since, today(profileId)) ?? 6) + 1;
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
    for (const c of parseComponents(a.components))
      if (c?.type) addType(c.type, a.date);
  }

  // Mobility-region (#840) targets count DISTINCT DAYS a recovery session mobilized the
  // region this week — the move→MuscleId→MuscleRegion rollup, deduped once per day (#223).
  // A SEPARATE view from strength `region` targets (#482: trained ≠ mobilized), gathered
  // from recovery activities' move components (never exercise_sets). One computation:
  // the same mobilityRegionDays the coverage strip uses.
  const mobilityRegionDates = new Map<MuscleRegion, Set<string>>();
  if (targets.some((t) => t.scope_kind === "mobility_region")) {
    const sessions: MobilitySessionInput[] = actRows
      .filter((a) => a.type === "recovery")
      .map((a) => ({
        date: a.date,
        moves: parseComponents(a.components)
          .filter((c) => c?.type === "recovery" && typeof c.name === "string")
          .map((c) => c.name),
      }));
    for (const [region, dates] of mobilityRegionDays(
      sessions,
      today(profileId),
      0
    ))
      mobilityRegionDates.set(region, dates);
  }

  // Food-habit (#580) targets count this week's SERVINGS for the group — the #579
  // weekly rollup's per-group sum, NOT a second count (one question, one computation).
  // Gathered once for all food_group targets. Profile-scoped by the same window.
  const foodServings = new Map<string, number>();
  if (targets.some((t) => t.scope_kind === "food_group")) {
    for (const r of db
      .prepare(
        `SELECT group_key, COALESCE(SUM(servings), 0) AS n FROM food_log
          WHERE profile_id = ? AND date >= ? GROUP BY group_key`
      )
      .all(profileId, since) as { group_key: string; n: number }[])
      foodServings.set(r.group_key, r.n);
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
    } else if (t.scope_kind === "food_group") {
      count = foodServings.get(t.scope_value) ?? 0;
    } else if (t.scope_kind === "mobility_region") {
      count = mobilityRegionDates.get(t.scope_value as MuscleRegion)?.size ?? 0;
    } else {
      count = typeDates.get(t.scope_value)?.size ?? 0;
    }
    return {
      target: t,
      count,
      per_week: t.per_week,
      met: count >= t.per_week,
      pace: frequencyPace(count, t.per_week, elapsedDays),
    };
  });
}

// ---- Strength / exercise history ----
