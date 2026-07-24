// Plateau-break advice — the ONE computation behind the "deload or a variation"
// recommendation that renders on all three plateau surfaces (#1203, applying the
// #221 one-computation-many-formatters discipline to advice copy):
//
//   1. the plateau finding detail        (lib/training-observations.ts → detectPlateaus)
//   2. the next-set rationale            (lib/coaching/strength.ts → suggestNextSet)
//   3. the inline activity-form hint     (components/activity-form/StrengthSets.tsx, #923)
//
// Before this, each surface hand-phrased the advice differently — only the finding
// carried the concrete "~10%" magnitude, and none of them NAMED a variation (a
// dead-end suggestion). This module owns both concrete facts so every surface shows
// the same ones: the deload magnitude (`deloadPhrase`) and 1–2 named catalog
// variations (`plateauVariations`). Pure and client-safe — no DB/network.

import {
  liftInfo,
  exerciseHistoryKey,
  LIFT_OPTIONS,
  type MuscleId,
} from "./lifts";

// The ad-hoc deload magnitude — the ONE place the "~10%" fact lives, shared verbatim
// across the surfaces so they can't drift (#1203).
const DELOAD_DROP = "drop the load ~10% and rebuild";

// A deload week the active routine's mesocycle already schedules soon (#741) — the
// plateau finding cross-references it so it points at that built-in light week
// instead of recommending an ad-hoc deload. `weeksUntilDeload` is 0 when this IS the
// deload week. Null ⇒ no cycle / not soon, so the finding keeps its ad-hoc phrasing.
export interface UpcomingDeload {
  weeksUntilDeload: number;
}

// Phrase how soon the routine's deload week arrives, for the plateau cross-reference.
function deloadWhen(weeksUntilDeload: number): string {
  if (weeksUntilDeload <= 0) return "is this week";
  if (weeksUntilDeload === 1) return "is next week";
  return `is ${weeksUntilDeload} weeks away`;
}

/**
 * 1–2 concrete catalog lifts to swap in for a plateaued lift (#1203). Resolves the
 * plateaued lift's `LiftDef`, then picks other picker-selectable catalog lifts that
 * share a `primaryMuscles` `MuscleId` with it — falling back to the same movement
 * `pattern` when no same-muscle sibling exists — EXCLUDING any that collapse to the
 * SAME `exerciseHistoryKey` (#482). The exclusion is the crux: an equipment/variant
 * sibling (barbell → dumbbell of the same lift) shares one progression history, so it
 * would neither start a fresh stimulus nor escape the plateau. Deterministic
 * (alphabetical), capped at 2.
 *
 * Graceful degradation: a custom/freeform lift not in the catalog, or one with no
 * distinct-`exerciseHistoryKey` sibling, returns `[]` — the caller keeps the bare
 * "a variation" phrasing and never fabricates a name.
 */
export function plateauVariations(exercise: string): string[] {
  const def = liftInfo(exercise);
  if (!def) return [];
  const sourceKey = exerciseHistoryKey(exercise);
  const primary = new Set<MuscleId>(def.primaryMuscles);
  const sameMuscle: string[] = [];
  const samePattern: string[] = [];
  for (const name of LIFT_OPTIONS) {
    const cand = liftInfo(name);
    if (!cand) continue;
    // The variant-sibling exclusion (#482): anything collapsing to the plateaued
    // lift's history is not a fresh stimulus.
    if (exerciseHistoryKey(name) === sourceKey) continue;
    if (cand.primaryMuscles.some((m) => primary.has(m))) {
      sameMuscle.push(cand.name);
    } else if (cand.pattern === def.pattern) {
      samePattern.push(cand.name);
    }
  }
  const pool = sameMuscle.length ? sameMuscle : samePattern;
  return pool.sort((a, b) => a.localeCompare(b)).slice(0, 2);
}

// The unified plateau-break advice: the two concrete facts every surface must show
// consistently (#1203). `deloadPhrase` is always the shared ~10% magnitude;
// `scheduledDeloadWhen` (non-null only when a routine deload is ≤2 weeks out, #741)
// lets the finding point at that scheduled light week instead. `variationPhrase`
// names 1–2 catalog variations, or degrades to the bare "a variation".
export interface PlateauBreakAdvice {
  variations: string[];
  variationPhrase: string;
  deloadPhrase: string;
  scheduledDeloadWhen: string | null;
}

export function plateauBreakAdvice(
  exercise: string,
  opts: { upcomingDeload?: UpcomingDeload | null } = {}
): PlateauBreakAdvice {
  const upcomingDeload = opts.upcomingDeload ?? null;
  const variations = plateauVariations(exercise);
  const variationPhrase = variations.length
    ? `a variation (${variations.join(", ")})`
    : "a variation";
  const scheduledDeloadWhen =
    upcomingDeload != null && upcomingDeload.weeksUntilDeload <= 2
      ? deloadWhen(upcomingDeload.weeksUntilDeload)
      : null;
  return {
    variations,
    variationPhrase,
    deloadPhrase: DELOAD_DROP,
    scheduledDeloadWhen,
  };
}

// The terse combined clause shared by the next-set rationale and the inline form
// hint — both concrete facts in one noun phrase, so each surface just adds its own
// lead verb ("try …" / "consider …"):
//   "a deload (drop the load ~10% and rebuild) or a variation (Incline Bench Press)"
export function plateauBreakClause(advice: PlateauBreakAdvice): string {
  return `a deload (${advice.deloadPhrase}) or ${advice.variationPhrase}`;
}

// Surface 1 — the plateau finding detail (Training → Overview, dashboard rollup,
// Telegram). Uses the scheduled-deload-week pointer when one is imminent (#741),
// else the ad-hoc ~10% drop; both name the variations.
export function plateauFindingDetail(
  exercise: string,
  upcomingDeload: UpcomingDeload | null = null
): string {
  const advice = plateauBreakAdvice(exercise, { upcomingDeload });
  const lead = `Your estimated 1RM for ${exercise} has been flat for about 6 weeks.`;
  if (advice.scheduledDeloadWhen) {
    return (
      `${lead} Your routine's deload week ${advice.scheduledDeloadWhen} — ` +
      `that built-in light week is a good chance to let this lift recover; ` +
      `swapping in ${advice.variationPhrase} can also restart progression.`
    );
  }
  return (
    `${lead} A short deload — ${advice.deloadPhrase} — or swapping in ` +
    `${advice.variationPhrase} can restart progression.`
  );
}

// Surface 3 — the inline activity-form plateau hint (#923). Terse, always the
// ad-hoc ~10% form (it yields to the deload rationale on a deload week upstream).
export function plateauInlineHint(exercise: string): string {
  return `Flat ~6 weeks — consider ${plateauBreakClause(plateauBreakAdvice(exercise))}.`;
}
