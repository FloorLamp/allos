// Static exercise how-to guides. Reads the committed lib/exercise-guides.json —
// a form-reference entry (setup steps, execution cues, common mistakes, and the
// muscles worked) for every catalog exercise — and exposes a pure accessor keyed
// by `exerciseHistoryKey`, so equipment variants ("Barbell Curl"/"Dumbbell
// Curl"/"Curl") all resolve to the ONE guide for their base lift (#221/#482:
// identity through exerciseHistoryKey, never the raw display name).
//
// No DB or network — it's a map over a bundled asset, so the guides work FULLY
// OFFLINE (no runtime ANTHROPIC_API_KEY; the authoring script that produced the
// JSON is a build-time step). Custom (non-catalog) lifts have no guide and the
// accessor returns `undefined` for them, so the #734 UI simply hides the
// affordance. INFORMATIONAL FORM REFERENCE, NOT MEDICAL ADVICE.

import guidesJson from "./exercise-guides.json";
import { type Equipment, type MuscleId, exerciseHistoryKey } from "./lifts";

export interface ExerciseGuide {
  // The `exerciseHistoryKey` this guide is filed under ("curl", "romanian
  // deadlift", …). Variant names collapse to it before lookup.
  key: string;
  // Ordered setup steps (stance, grip, bracing) before the first rep.
  setup: string[];
  // Ordered movement cues through one rep.
  execution: string[];
  // One line on breathing/bracing timing, when it materially helps.
  breathing?: string;
  // Frequent form errors to avoid.
  commonMistakes: string[];
  // Informational safety notes (never medical advice) — spotting, load ramp,
  // range-of-motion caveats. Present only where the lift warrants one.
  safetyNotes?: string[];
  // Cues that genuinely differ by implement, only for the keys whose equipment
  // variants change the movement. Absent when one guide covers every variant.
  equipmentNotes?: Partial<Record<Equipment, string>>;
  // Prime movers / meaningful assistors, as fine-grained MuscleIds. Sourced from
  // the catalog lift's tags (#735) so the guide and the coverage/anatomy layers
  // agree by construction — one computation, one identity (#482).
  primaryMuscles: MuscleId[];
  secondaryMuscles: MuscleId[];
}

const GUIDES: ExerciseGuide[] =
  (guidesJson as { guides?: ExerciseGuide[] }).guides ?? [];

// Index by exerciseHistoryKey (already lowercased/trimmed by the generator).
// Built once at load.
const BY_KEY: Map<string, ExerciseGuide> = (() => {
  const map = new Map<string, ExerciseGuide>();
  for (const g of GUIDES) map.set(g.key, g);
  return map;
})();

/**
 * The how-to guide for a lift, or `undefined` when none exists. Resolves the
 * lookup name through `exerciseHistoryKey` FIRST (so "Dumbbell Curl", "Barbell
 * Curl", and "Curl" all reach the ONE "curl" guide), then indexes. A non-catalog
 * custom lift keys to its own trimmed/lowercased name, which is absent from the
 * guide set, so this returns `undefined` — the #734 UI hides the affordance for
 * those. Pure; no DB.
 */
export function getExerciseGuide(
  name: string | null | undefined
): ExerciseGuide | undefined {
  if (!name) return undefined;
  return BY_KEY.get(exerciseHistoryKey(name));
}

/** Whether a lift has a how-to guide (catalog lifts do; custom lifts don't). */
export function hasExerciseGuide(name: string | null | undefined): boolean {
  return getExerciseGuide(name) !== undefined;
}

/** All guides, for iteration (e.g. the completeness test). */
export function allExerciseGuides(): ExerciseGuide[] {
  return GUIDES;
}
