// PURE per-session comparison math for one movement — the Training comparison tab's
// numbers, computed from set rows instead of from the database (#5172). The gather
// (`getExerciseComparison` in lib/queries/training/strength.ts) reads the rows and the
// bodyweight series; every decision about what those rows MEAN is stated here, once:
//
//   - the LOAD-CONTEXT narrowing (#1610): a session that touched two implements
//     contributes only its comparable sets, never a blended top weight / e1RM / volume;
//   - the bodyweight fold: for a catalog bodyweight lift the athlete IS (part of) the
//     load, resolved as of the session date and reported beside the total so a reader
//     can subtract it (#3009);
//   - the e1RM tie-break: equal estimates resolve to the higher rep count, the same
//     tie-break the all-history aggregate uses, so a PR classification can't disagree
//     with the stat it is compared against.
//
// No DB, no clock, no network — the same math runs in the query, in a test, and in any
// future surface that already holds the rows.

import { bodyweightAsOf } from "./bodyweight";
import {
  effectiveLoadKg,
  equipmentLoadLane,
  isBodyweight,
  loadKindOf,
} from "./lifts";
import type { WeightUnit } from "./settings";
import { estimate1RM } from "./strength";
import { summarizeExercise } from "./training-log-format";

export interface ExerciseCompareSession {
  date: string;
  activityId: number;
  // The session's LOAD CONTEXT (#1610): the registry implement its sets were
  // performed on, or null for the unassigned lane. `equipment` is the same lane's
  // display label, resolved together with the id so the two cannot disagree.
  equipmentId: number | null;
  equipment: string | null;
  setCount: number;
  totalReps: number;
  volumeKg: number;
  topWeightKg: number | null;
  topReps: number | null;
  // The BODYWEIGHT included in `topWeightKg` for a catalog bodyweight lift, or 0.
  // Kept beside the total because a pull-up's "load" is the athlete, so a reader
  // asking "did I get stronger" must be able to subtract it: without this, two
  // identical pull-up sessions three kilos of weight-loss apart look like a three
  // kilo regression (#3009 review).
  bodyweightBaseKg: number;
  e1rmKg: number | null;
  // Reps on the set backing e1rmKg. The all-history strength aggregate uses
  // more reps to break an equal-e1RM tie, so historical PR classification must
  // carry the same tie-breaker.
  e1rmReps: number | null;
  summary: string;
}

// One warmup-free working set of the compared movement, as the gather selects it.
export interface ComparisonSetRow {
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
  equipment_id: number | null;
  equipment: string | null;
}

// Fold the movement's warmup-free sets (date+id+set_number ascending) into one row
// per session. `weights` is the profile's bodyweight series ascending by date.
//
// `opts.equipmentLane` narrows to ONE load context (#1610) — the shared
// `equipmentLoadLane` string, so "none" is the explicit unassigned lane and never a
// wildcard. Two registry machines both serialize as the same exact logged name, so
// without the lane a hotel chest press's 50 kg and a home machine's 80 kg would be
// charted as one progression and their session table read as one history. Omitted,
// the fold stays movement-wide — the shape a profile with no registry equipment (a
// single lane) gets either way.
export function foldExerciseComparison(
  all: ComparisonSetRow[],
  weights: { date: string; weight_kg: number }[],
  unit: WeightUnit,
  opts: { equipmentLane?: string } = {}
): ExerciseCompareSession[] {
  // Narrow to the requested load context BEFORE the per-session fold, so a session
  // that touched two implements contributes only its comparable sets rather than a
  // blended top weight / e1RM / volume (#1610).
  const rows =
    opts.equipmentLane == null
      ? all
      : all.filter(
          (r) => equipmentLoadLane(r.equipment_id) === opts.equipmentLane
        );

  if (rows.length === 0) return [];

  const addBodyweight = isBodyweight(rows[0].exercise);
  // How a logged weight combines with that base (#1922) — `assisted` subtracts.
  const loadKind = loadKindOf(rows[0].exercise);
  const bySession = new Map<
    number,
    {
      date: string;
      activityId: number;
      equipmentId: number | null;
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
        equipmentId: null,
        equipment: null,
        rows: [],
      };
      bySession.set(r.activity_id, session);
    }
    // Id and label resolved TOGETHER off the first implement-bearing set, so the
    // lane a row reports and the name it renders can never disagree (#1610).
    if (session.equipmentId == null && r.equipment_id != null) {
      session.equipmentId = r.equipment_id;
      session.equipment = r.equipment;
    }
    session.rows.push(r);
  }

  return [...bySession.values()].map((s) => {
    const baseKg = addBodyweight ? (bodyweightAsOf(weights, s.date) ?? 0) : 0;
    let totalReps = 0;
    let volumeKg = 0;
    let topWeightKg: number | null = null;
    let topReps: number | null = null;
    let e1rmKg: number | null = null;
    let e1rmReps: number | null = null;

    for (const r of s.rows) {
      const sides: { weight: number; reps: number }[] = [];
      if (r.reps != null)
        sides.push({
          weight: effectiveLoadKg(loadKind, baseKg, r.weight_kg),
          reps: r.reps,
        });
      if (r.reps_right != null)
        sides.push({
          weight: effectiveLoadKg(loadKind, baseKg, r.weight_kg_right),
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
          (estimate === e1rmKg && side.reps > (e1rmReps ?? 0))
        ) {
          e1rmKg = estimate;
          e1rmReps = side.reps;
        }
      }
    }

    return {
      date: s.date,
      activityId: s.activityId,
      equipmentId: s.equipmentId,
      equipment: s.equipment,
      setCount: s.rows.length,
      totalReps,
      volumeKg,
      topWeightKg,
      topReps,
      e1rmKg,
      bodyweightBaseKg: baseKg,
      summary: summarizeExercise(s.rows, unit).text,
      e1rmReps,
    };
  });
}
