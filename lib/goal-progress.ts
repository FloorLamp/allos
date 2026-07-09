// Pure progress computation for exercise-linked and body-metric goals. Extracted
// from lib/queries.ts so the logic is unit-testable (no DB/network) — queries.ts
// wires these to the stored sets / latest body-metric values.

import type { Goal } from "./types";

export interface GoalProgress {
  current: number;
  target: number;
  pct: number;
  done: boolean;
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
}

// Small absolute tolerance for treating a body-metric value as "at" its target
// when no directional baseline is available (float rounding on stored kg/%/bpm).
const BODY_TARGET_TOLERANCE = 1e-6;

export function computeGoalProgress(
  goal: Goal,
  sets: GoalSetRow[]
): GoalProgress {
  const pack = (current: number, target: number): GoalProgress => {
    const pct =
      target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    return { current, target, pct, done: target > 0 && current >= target };
  };

  if (goal.metric === "weight") {
    const target = goal.target_weight_kg ?? 0;
    let current = 0;
    for (const s of sets)
      current = Math.max(current, s.weight_kg ?? 0, s.weight_kg_right ?? 0);
    return pack(current, target);
  }

  if (goal.metric === "hold") {
    const target = goal.target_duration_sec ?? 0;
    let current = 0;
    for (const s of sets)
      current = Math.max(
        current,
        s.duration_sec ?? 0,
        s.duration_sec_right ?? 0
      );
    return pack(current, target);
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
    const target = goal.target_reps ?? 0;
    let current = 0;
    for (const s of sets) {
      const l = sideReps(s.weight_kg, s.reps);
      const r = sideReps(s.weight_kg_right, s.reps_right);
      current = Math.max(current, l ?? 0, r ?? 0);
    }
    return pack(current, target);
  }

  if (goal.metric === "sets") {
    const target = goal.target_sets ?? 0;
    const needReps = goal.target_reps ?? 1;
    // Count, per session, the sets where either side meets the rep (+weight) bar;
    // current = the best single session.
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
    return pack(current, target);
  }

  return pack(0, 0);
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
