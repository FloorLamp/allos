// Pure progress computation for exercise-linked and body-metric goals. Extracted
// from lib/queries.ts so the logic is unit-testable (no DB/network) — queries.ts
// wires these to the stored sets / latest body-metric values.

import { shiftDateStr } from "./date";
import type { Goal } from "./types";

export interface GoalProgress {
  current: number;
  target: number;
  pct: number;
  done: boolean;
  // Best value across ALL logged sets ever — the lifetime PR — regardless of the
  // recency window. `current` is the best within the trailing window (when a
  // `today` is supplied); this is exposed separately so the UI can still surface
  // the PR after detraining drops `current` below it (issue #44 item 1). Only the
  // exercise-linked goals set it; body-metric goals (computeBodyGoalProgress)
  // leave it undefined.
  lifetimeBest?: number;
}

export interface GoalSetRow {
  activity_id: number;
  exercise: string;
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  duration_sec: number | null;
  duration_sec_right: number | null;
  // Activity date (YYYY-MM-DD). Optional so callers/tests that don't window can
  // omit it; when `today` is passed to computeGoalProgress, only sets whose date
  // falls in the trailing window count toward `current`.
  date?: string;
}

// Small absolute tolerance for treating a body-metric value as "at" its target
// when no directional baseline is available (float rounding on stored kg/%/bpm).
const BODY_TARGET_TOLERANCE = 1e-6;

// Trailing window (days, inclusive of today) that defines the "current" best for
// an exercise-linked goal. A lift you last hit two months ago is no longer your
// current level, so it drops out of `current` and only survives as the lifetime
// PR — that's what stops the bar from reading ~90% forever after you detrain
// (issue #44 item 1).
export const GOAL_RECENT_WINDOW_DAYS = 28;

// Target value for the goal's metric (0 when the metric doesn't apply).
function targetForGoal(goal: Goal): number {
  switch (goal.metric) {
    case "weight":
      return goal.target_weight_kg ?? 0;
    case "hold":
      return goal.target_duration_sec ?? 0;
    case "reps":
      return goal.target_reps ?? 0;
    case "sets":
      return goal.target_sets ?? 0;
    default:
      return 0;
  }
}

// Best achieved value for the goal's metric across `sets` (0 when none qualify).
// Pure over whatever subset it's handed, so the same logic computes both the
// lifetime best (all sets) and the recent best (windowed sets).
function bestValueForGoal(goal: Goal, sets: GoalSetRow[]): number {
  if (goal.metric === "weight") {
    let current = 0;
    for (const s of sets)
      current = Math.max(current, s.weight_kg ?? 0, s.weight_kg_right ?? 0);
    return current;
  }

  if (goal.metric === "hold") {
    let current = 0;
    for (const s of sets)
      current = Math.max(
        current,
        s.duration_sec ?? 0,
        s.duration_sec_right ?? 0
      );
    return current;
  }

  const minWeight = goal.target_weight_kg ?? null;
  // A side qualifies when it has reps and meets the optional weight floor. Each
  // side of a per-side set is an independent candidate (mirrors getStrengthByExercise).
  const sideReps = (w: number | null, r: number | null): number | null => {
    if (r == null) return null;
    if (minWeight != null && (w ?? 0) < minWeight) return null;
    return r;
  };

  if (goal.metric === "reps") {
    let current = 0;
    for (const s of sets) {
      const l = sideReps(s.weight_kg, s.reps);
      const r = sideReps(s.weight_kg_right, s.reps_right);
      current = Math.max(current, l ?? 0, r ?? 0);
    }
    return current;
  }

  if (goal.metric === "sets") {
    const needReps = goal.target_reps ?? 1;
    // Count, per session, the sets where either side meets the rep (+weight) bar;
    // best = the best single session.
    const perSession = new Map<number, number>();
    for (const s of sets) {
      const l = sideReps(s.weight_kg, s.reps);
      const r = sideReps(s.weight_kg_right, s.reps_right);
      const best = Math.max(l ?? 0, r ?? 0);
      if (best >= needReps)
        perSession.set(s.activity_id, (perSession.get(s.activity_id) ?? 0) + 1);
    }
    let current = 0;
    for (const c of perSession.values()) current = Math.max(current, c);
    return current;
  }

  return 0;
}

// Progress for an exercise-linked goal. `current` is the best within the trailing
// GOAL_RECENT_WINDOW_DAYS window (relative to `today`), so the bar tracks recent
// form; `lifetimeBest` is the all-time PR. When `today` is omitted, windowing is
// skipped and `current` equals `lifetimeBest` (backward-compatible with callers
// and tests that don't pass a date).
export function computeGoalProgress(
  goal: Goal,
  sets: GoalSetRow[],
  today?: string
): GoalProgress {
  const target = targetForGoal(goal);
  const lifetimeBest = bestValueForGoal(goal, sets);
  let current = lifetimeBest;
  if (today) {
    const cutoff = shiftDateStr(today, -(GOAL_RECENT_WINDOW_DAYS - 1));
    const recent = sets.filter(
      (s) => s.date != null && s.date >= cutoff && s.date <= today
    );
    current = bestValueForGoal(goal, recent);
  }
  const pct =
    target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  return {
    current,
    target,
    pct,
    // A target hit at ANY point counts as done — hitting 100 kg two months ago
    // is still an achievement (it tints "Mark achieved"), even though the bar
    // (`current`/`pct`) has since dropped back to recent form.
    done: target > 0 && lifetimeBest >= target,
    lifetimeBest,
  };
}

// Progress for a body-metric goal: how far the current value has moved from the
// baseline (captured at creation) toward the target. Direction-agnostic, so a
// reduction goal (lose weight, lower HR) reads 0→100% just like a gain goal.
export function computeBodyGoalProgress(
  goal: Goal,
  current: number | null
): GoalProgress {
  const target = goal.target_value ?? 0;
  const baseline = goal.baseline_value;
  if (current == null) return { current: 0, target, pct: 0, done: false };
  if (baseline == null || baseline === target) {
    // No usable baseline to measure directional progress from (missing, or a
    // maintain goal where baseline === target): we can't compute a meaningful
    // percentage, so completion is simply the current value reaching the target
    // (within a small tolerance). This fixes both a maintain goal that used to
    // read "achieved" forever regardless of the current value, and a null
    // baseline that could never complete even when current already hit target.
    const done = Math.abs(current - target) <= BODY_TARGET_TOLERANCE;
    return { current, target, pct: done ? 100 : 0, done };
  }
  const ratio = (current - baseline) / (target - baseline);
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return { current, target, pct, done: pct >= 100 };
}
