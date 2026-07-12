import type { WeightUnit } from "./settings";
import type { IntegrationId } from "./types";
import { kgTo, round } from "./units";
import { formatSeconds } from "./duration";
import { getIntegration } from "./integrations/registry";
import { DOCUMENT_SOURCE_PREFIX } from "./body-metric-extract";

// Provenance label for an activity's `source` (issue #11), mirroring the
// body-metrics history convention (lib/queries/metrics.ts): a manual row (source
// NULL or the journal's 'manual') reads "Manual"; an integration id resolves to
// its registry display name ('strava' -> "Strava", 'health-connect' -> "Google
// Health Connect"); a doc-extracted row ('document:<id>') reads "Document"; any
// other value shows verbatim. When a source-owned (imported) row has been
// hand-edited (edited=1) it reads "<Source> · edited" — e.g. "Strava · edited".
export function activityProvenanceLabel(
  source: string | null,
  edited?: number | null
): string {
  const imported = !!source && source !== "manual";
  let base: string;
  if (!imported) base = "Manual";
  else if (source!.startsWith(DOCUMENT_SOURCE_PREFIX)) base = "Document";
  else base = getIntegration(source as IntegrationId)?.name ?? source!;
  return imported && edited ? `${base} · edited` : base;
}

export interface SetRow {
  set_number: number;
  weight_kg: number | null;
  reps: number | null;
  // Right-side load for per-side (asymmetric) sets; absent/null for bilateral.
  weight_kg_right?: number | null;
  reps_right?: number | null;
  // Hold time (seconds) for timed exercises; absent/null for rep-based sets.
  duration_sec?: number | null;
  duration_sec_right?: number | null;
  // Declared intent: the planned rep count, or "to failure" (AMRAP, 1 = true).
  // Absent/null when no intent was declared.
  target_reps?: number | null;
  to_failure?: number | null;
  // Warmup flag (#338, 1 = warmup): a warmup set is shown but excluded from the
  // target judgment and the volume total below.
  warmup?: number | null;
}

// "met" = every targeted set hit its declared rep target; "missed" = at least
// one targeted set fell short. null = no judgment: no targets declared, a
// to-failure (AMRAP) plan, timed holds, or per-side sets. Rep variance alone
// is deliberately NOT a signal — it false-positives on 5/3/1, pyramids, drop
// sets, and rep-range programming.
export type SetStatus = "met" | "missed" | null;

// Tooltip copy for the status icons — shared by every surface that renders
// them so the wording can't fork.
export const SET_STATUS_TITLES: Record<Exclude<SetStatus, null>, string> = {
  met: "All sets hit their target reps",
  missed: "At least one set fell short of its target reps",
};

// The one place the hit/missed-target rule lives (the editor's live marker and
// the recent-history queries share it): sets with a declared positive target
// that aren't AMRAP ("to failure") must reach it; without any such set there
// is no judgment.
export function judgeTargets(
  sets: {
    reps: number | null;
    target_reps?: number | null;
    to_failure?: number | null;
    warmup?: number | null;
  }[]
): SetStatus {
  const targeted = sets.filter(
    (s) =>
      // A warmup set never counts toward met/missed (#338) — a light warmup
      // single under the part's target must not read as a missed set.
      !s.warmup &&
      s.target_reps != null &&
      s.target_reps > 0 &&
      !s.to_failure &&
      s.reps != null
  );
  if (targeted.length === 0) return null;
  return targeted.every((s) => s.reps! >= s.target_reps!) ? "met" : "missed";
}

export interface ExerciseSummary {
  text: string; // e.g. "200lb × 5 × 3", "150lb × 8, 8, 7", or "1:00 × 3" (timed)
  status: SetStatus;
  totalKg: number; // total weight lifted (kg) = Σ weight × reps (0 for timed)
}

function fmtW(kg: number, unit: WeightUnit): string {
  return `${round(kgTo(kg, unit), 1)}${unit}`;
}

// Render a per-set "effort" value: reps as a plain number, hold time as m:ss.
const repsFmt = (v: number | null) => (v == null ? "–" : String(v));
const timeFmt = (v: number | null) => formatSeconds(v);

/**
 * Build the set text for a single column of (weight, value) pairs, grouping
 * consecutive sets of the same weight. `value` is reps for rep-based lifts or
 * seconds for timed holds, rendered by `fmtVal`:
 *  - uniform value (≥2 sets): "200lb × 5 × 3" / "1:00 × 3"
 *  - varying value:           "150lb × 8, 8, 7"
 *  - changing weight:         "100lb × 6, 5, 95lb × 8"
 * Bodyweight (0/null weight) drops the "0lb ×" prefix.
 */
function setsText(
  rows: { weight: number | null; value: number | null }[],
  unit: WeightUnit,
  fmtVal: (v: number | null) => string
): string {
  const groups: { weight: number | null; vals: (number | null)[] }[] = [];
  for (const s of rows) {
    const last = groups[groups.length - 1];
    if (last && last.weight === s.weight) last.vals.push(s.value);
    else groups.push({ weight: s.weight, vals: [s.value] });
  }

  return groups
    .map((g) => {
      const allEqual = g.vals.every((v) => v === g.vals[0]);
      const valText =
        allEqual && g.vals.length > 1
          ? `${fmtVal(g.vals[0])} × ${g.vals.length}`
          : g.vals.map(fmtVal).join(", ");
      if (g.weight == null || g.weight === 0) return valText;
      return `${fmtW(g.weight, unit)} × ${valText}`;
    })
    .join(", ");
}

/**
 * Summarize an exercise's sets, grouping consecutive sets of the same weight:
 *  - uniform reps (≥2 sets): "200lb × 5 × 3"
 *  - varying reps:           "150lb × 8, 8, 7"
 *  - timed holds:            "1:00 × 3" (reps replaced by m:ss)
 *
 * Status compares actual reps against declared targets (see SetStatus): sets
 * with a target that aren't marked to-failure must reach it. Without declared
 * intent there is no status.
 */
export function summarizeExercise(
  sets: SetRow[],
  unit: WeightUnit
): ExerciseSummary {
  const ordered = [...sets].sort((a, b) => a.set_number - b.set_number);

  // Timed holds measure seconds, not reps; render m:ss in place of reps.
  const timed = ordered.some(
    (s) => s.duration_sec != null || s.duration_sec_right != null
  );
  const valOf = timed
    ? (s: SetRow) => s.duration_sec ?? null
    : (s: SetRow) => s.reps;
  const fmtVal = timed ? timeFmt : repsFmt;

  // Per-side (asymmetric) sets are rendered explicitly so the L/R imbalance is
  // visible rather than collapsed into a single number.
  const hasPerSide = ordered.some(
    (s) =>
      s.weight_kg_right != null ||
      s.reps_right != null ||
      s.duration_sec_right != null
  );
  if (hasPerSide) return summarizePerSide(ordered, unit, timed);

  const text = setsText(
    ordered.map((s) => ({ weight: s.weight_kg, value: valOf(s) })),
    unit,
    fmtVal
  );

  const status: SetStatus = timed ? null : judgeTargets(ordered);

  // Warmups are excluded from the volume total (#338) — they're shown in the
  // text but aren't working volume.
  const totalKg = timed
    ? 0
    : ordered.reduce(
        (sum, s) => sum + (s.warmup ? 0 : (s.weight_kg ?? 0) * (s.reps ?? 0)),
        0
      );

  return { text, status, totalKg };
}

/**
 * Summarize per-side (asymmetric) sets by summarizing each side independently
 * with the same grouping as the bilateral path, joined with " · " so the L/R
 * difference stays visible and compact:
 * "L 14lb × 10, 10, 9 · R 12lb × 8 × 3", or timed "L 0:45 × 3 · R 0:40 × 3".
 */
function summarizePerSide(
  ordered: SetRow[],
  unit: WeightUnit,
  timed: boolean
): ExerciseSummary {
  const fmtVal = timed ? timeFmt : repsFmt;
  const leftVal = timed
    ? (s: SetRow) => s.duration_sec ?? null
    : (s: SetRow) => s.reps;
  const rightVal = timed
    ? (s: SetRow) => s.duration_sec_right ?? null
    : (s: SetRow) => s.reps_right ?? null;

  const left = setsText(
    ordered.map((s) => ({ weight: s.weight_kg, value: leftVal(s) })),
    unit,
    fmtVal
  );
  const right = setsText(
    ordered.map((s) => ({
      weight: s.weight_kg_right ?? null,
      value: rightVal(s),
    })),
    unit,
    fmtVal
  );

  const totalKg = timed
    ? 0
    : ordered.reduce(
        (sum, s) =>
          s.warmup
            ? sum
            : sum +
              (s.weight_kg ?? 0) * (s.reps ?? 0) +
              (s.weight_kg_right ?? 0) * (s.reps_right ?? 0),
        0
      );

  return { text: `L ${left} · R ${right}`, status: null, totalKg };
}
