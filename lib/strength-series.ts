// PURE dated estimated-1RM series math (#5172). The gather
// (`getExerciseE1rmSeries` in lib/queries/training/strength.ts) reads the rep-bearing,
// warmup-free set rows and the bodyweight series; this module decides what they mean.
//
// Three rules live here and nowhere else:
//
//   - the GROUPING axis (#1610): movement-wide by the canonical `exerciseHistoryKey`,
//     or one series per (movement, implement) via `movementLoadKey` when the caller
//     opts in. A home chest press and a hotel chest press are not one progression;
//     averaging them fabricates a flat slope out of two healthy ones.
//   - the EQUIPMENT-CATEGORY restriction (#2326/#3132): a set whose implement
//     contradicts a free-weight population standard contributes NO point — skipped
//     outright rather than zeroed, so a machine-only day yields no point and a
//     machine-only movement yields no series. That is the honest answer: a barbell
//     table has nothing to say about either.
//   - the bodyweight fold and the per-day best, whose tie at equal e1RM resolves to
//     the higher rep count so the plateau detector's rep-progression escape hatch
//     (12→15→18 reps at a fixed load all cap to one e1RM) stays visible.
//
// Pure — no DB, no clock, no network.

import { bodyweightAsOf } from "./bodyweight";
import { contradictsFreeWeightStandard } from "./equipment-availability";
import {
  effectiveLoadKg,
  exerciseHistoryKey,
  isBodyweight,
  loadKindOf,
  movementLoadKey,
  type LoadKind,
} from "./lifts";
import { estimate1RM } from "./strength";

export interface E1rmSeriesRow {
  exercise: string;
  // The load context this series belongs to when grouped by it — the registry
  // equipment id and its label, both null for the unassigned lane and always null
  // when grouping movement-wide.
  equipmentId: number | null;
  equipment: string | null;
  points: { date: string; value: number; reps: number }[];
}

// One rep-bearing, warmup-free set as the gather selects it.
export interface E1rmSetRow {
  exercise: string;
  date: string;
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  equipmentId: number | null;
  equipment: string | null;
  // The implement's registry CATEGORY (#2326) — the axis a free-weight-restricted
  // series reads. NULL for a set with no equipment row, which is not a contradiction.
  equipmentCategory: string | null;
}

// Fold rep-bearing sets (date+id ascending) into one dated e1RM series per group.
// `weights` is the profile's bodyweight series ascending by date. Sessions whose best
// e1RM is 0 (bodyweight lifts with no known bodyweight) are omitted — a flat-zero
// series is not a plateau.
export function foldE1rmSeries(
  rows: E1rmSetRow[],
  weights: { date: string; weight_kg: number }[],
  opts: { byLoadContext?: boolean; freeWeightOnly?: boolean } = {}
): E1rmSeriesRow[] {
  const byLoadContext = opts.byLoadContext === true;
  const freeWeightOnly = opts.freeWeightOnly === true;
  // grouping key -> { display name (first-seen), load context, date -> best }
  const acc = new Map<
    string,
    {
      exercise: string;
      equipmentId: number | null;
      equipment: string | null;
      addBodyweight: boolean;
      loadKind: LoadKind;
      byDate: Map<string, { e1rm: number; reps: number }>;
    }
  >();
  for (const r of rows) {
    // Does THIS set's own implement rule it out of a free-weight comparison (#2326)?
    // Asked per set, exactly as the per-exercise stats ask it for freeWeightE1rmKg —
    // a name's history routinely mixes implements, and the row knows something the
    // name does not. Skipped outright rather than zeroed, so a machine-only day
    // contributes no point instead of a point the standards table can't read (#3132).
    if (freeWeightOnly && contradictsFreeWeightStandard(r.equipmentCategory))
      continue;
    // Canonical, variant-collapsed key so a lift's variants merge into ONE series
    // exactly as the per-exercise stats aggregate them (#331/#432) — plus the
    // equipment lane when the caller asked for load contexts (#1610).
    const key = byLoadContext
      ? movementLoadKey(r.exercise, r.equipmentId)
      : exerciseHistoryKey(r.exercise);
    let e = acc.get(key);
    if (!e) {
      e = {
        exercise: r.exercise,
        equipmentId: byLoadContext ? r.equipmentId : null,
        equipment: byLoadContext ? r.equipment : null,
        addBodyweight: isBodyweight(r.exercise),
        loadKind: loadKindOf(r.exercise),
        byDate: new Map(),
      };
      acc.set(key, e);
    }
    const base = e.addBodyweight ? (bodyweightAsOf(weights, r.date) ?? 0) : 0;
    const sides: { e1rm: number; reps: number }[] = [];
    if (r.reps != null)
      sides.push({
        e1rm: estimate1RM(
          effectiveLoadKg(e.loadKind, base, r.weight_kg),
          r.reps
        ),
        reps: r.reps,
      });
    if (r.reps_right != null)
      sides.push({
        e1rm: estimate1RM(
          effectiveLoadKg(e.loadKind, base, r.weight_kg_right),
          r.reps_right
        ),
        reps: r.reps_right,
      });
    for (const side of sides) {
      const prev = e.byDate.get(r.date);
      // Best e1RM that day; on a tie (e.g. reps past the cap, or bodyweight lifts)
      // keep the higher rep count so the rep-progression escape hatch can see it.
      if (
        !prev ||
        side.e1rm > prev.e1rm ||
        (side.e1rm === prev.e1rm && side.reps > prev.reps)
      )
        e.byDate.set(r.date, side);
    }
  }

  const out: E1rmSeriesRow[] = [];
  for (const e of acc.values()) {
    const points = [...e.byDate.entries()]
      .filter(([, v]) => v.e1rm > 0)
      .map(([date, v]) => ({ date, value: v.e1rm, reps: v.reps }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (points.length > 0)
      out.push({
        exercise: e.exercise,
        equipmentId: e.equipmentId,
        equipment: e.equipment,
        points,
      });
  }
  return out;
}
