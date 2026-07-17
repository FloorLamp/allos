// Typed accessors over the curated, CITED illness-care threshold dataset — the DOMAIN
// accessor over the curated-dataset framework's illness-thresholds dataset (issue #860
// Track B, wave 2; data + loader in lib/datasets/illness-thresholds.ts). Pure — no
// DB/network — so it is importable from the pure test tier, the engine, and the query
// layer alike. The committed envelope is hand-authored + human-reviewable (validated by
// lib/__tests__/illness-thresholds.test.ts).
//
// The #798 prn-defaults treatment applied to symptom DURATION: every entry is keyed
// by a #799 curated symptom SLUG (lib/symptoms.json), cites a public label/guideline
// line, and is age-banded ONLY where the source publishes a stricter band. There is
// NO entry for a symptom the source has no citable duration line for — and no entry
// ⇒ no finding for that symptom, ever (the load-bearing "cite, never generate" rule).

import {
  ILLNESS_THRESHOLD_ENTRIES,
  type IllnessThresholdEntry,
} from "./datasets/illness-thresholds";
import { isCuratedSymptom } from "./symptoms";

// Re-export the entry + rule types from their framework home so the existing consumer
// import paths (`@/lib/illness-thresholds`) are unchanged.
export type {
  IllnessThresholdEntry,
  IllnessDurationRule,
  IllnessTrajectoryRule,
  IllnessInfantRule,
} from "./datasets/illness-thresholds";

const ENTRIES = ILLNESS_THRESHOLD_ENTRIES;

// EXACT-slug map (behavior-preserving — stored keys are canonical #799 slugs; the
// lookup stays case-sensitive as before, NOT the framework matcher's case-fold).
const BY_SLUG = new Map(ENTRIES.map((e) => [e.slug, e]));

// The full curated dataset (for the dataset test + any catalogue surface).
export function illnessThresholdEntries(): readonly IllnessThresholdEntry[] {
  return ENTRIES;
}

// The cited threshold entry for a stored symptom key, or null when the symptom has
// no curated duration line (a custom free-text symptom, or a curated slug the
// dataset intentionally omits). Null ⇒ no illness-care finding for that symptom.
export function illnessThresholdFor(
  symptomKey: string
): IllnessThresholdEntry | null {
  return BY_SLUG.get(symptomKey) ?? null;
}

// Whether every dataset slug is a real #799 curated slug (dataset-test invariant —
// a threshold keyed on a slug outside the vocabulary can never match a logged row).
export function allThresholdSlugsAreCurated(): boolean {
  return ENTRIES.every((e) => isCuratedSymptom(e.slug));
}
