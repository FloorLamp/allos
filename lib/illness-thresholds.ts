// Typed accessors over the curated, CITED illness-care threshold dataset
// (lib/illness-thresholds.json, issue #805). Pure — no DB/network — so it is
// importable from the pure test tier, the engine, and the query layer alike. The
// committed JSON is hand-authored + human-reviewable (validated structurally by
// lib/__tests__/illness-thresholds.test.ts).
//
// The #798 prn-defaults treatment applied to symptom DURATION: every entry is keyed
// by a #799 curated symptom SLUG (lib/symptoms.json), cites a public label/guideline
// line, and is age-banded ONLY where the source publishes a stricter band. There is
// NO entry for a symptom the source has no citable duration line for — and no entry
// ⇒ no finding for that symptom, ever (the load-bearing "cite, never generate" rule).

import data from "./illness-thresholds.json";
import { isCuratedSymptom } from "./symptoms";

// A duration line: the SOURCE's stated day count. The engine fires the duration
// finding when the symptom has been logged MORE THAN `days` consecutive days
// (run > days), so `line` can quote the source number verbatim ("beyond N days").
export interface IllnessDurationRule {
  days: number;
  line: string;
}

// A trajectory line: fires the worsening variant when worst-severity has risen for
// `days` consecutive days (>= days). Labels say "if symptoms get worse" without a
// day count, so `days` is a fixed SUSTAINED-rise floor (2 = not a one-day blip) —
// a blip filter, not an invented clinical number (documented in the JSON _comment).
export interface IllnessTrajectoryRule {
  days: number;
  line: string;
}

// A source-published stricter age band (the #798 "below the floor renders 'ask a
// doctor', not a number" pattern): when the profile's age is at or below
// `maxAgeMonths`, ANY logged day of this symptom (run >= 1) renders the refusal
// `line` (with its OWN `source`) instead of the adult duration count.
export interface IllnessInfantRule {
  maxAgeMonths: number;
  line: string;
  source: string;
}

export interface IllnessThresholdEntry {
  // Stable #799 symptom slug — the KEY (must be a curated slug; a custom free-text
  // symptom never has an entry).
  slug: string;
  label: string;
  duration?: IllnessDurationRule;
  trajectory?: IllnessTrajectoryRule;
  infantRule?: IllnessInfantRule;
  // The cited source for this entry's adult duration/trajectory lines.
  source: string;
}

const ENTRIES = (data as { symptoms: IllnessThresholdEntry[] }).symptoms;

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
