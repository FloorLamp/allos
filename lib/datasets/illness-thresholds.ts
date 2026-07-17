// The illness-care symptom threshold dataset, loaded onto the curated-dataset
// framework (issue #860 Track B, wave 2). Copies the temperature-red-flags.ts /
// icd10-common.ts shape: import the envelope JSON (hand-authored + human-reviewable),
// validate it once with loadDataset(), build a slug-keyed matcher, and expose the
// entries the illness-care engine consumes. Identity is the #799 curated symptom SLUG
// (fieldStrategy "slug"). The registry lists this for the linter; lib/illness-thresholds
// .ts is the DOMAIN accessor. Pure — no DB, no network.
//
// REFUSAL POSTURE (#805): no entry for a symptom ⇒ no finding for it, ever. Each entry
// quotes a public label / guideline line verbatim with its own cited `source`; the
// infant band appears ONLY where the source publishes a stricter age band, and carries
// its own (stricter, pediatric) source.

import rawIllness from "./data/illness-thresholds.json";
import { loadDataset } from "./loader";
import { createMatcher, fieldStrategy } from "./matcher";

// A duration line: the SOURCE's stated day count. The engine fires the duration finding
// when the symptom has been logged MORE THAN `days` consecutive days (run > days), so
// `line` can quote the source number verbatim ("beyond N days").
export interface IllnessDurationRule {
  days: number;
  line: string;
}

// A trajectory line: fires the worsening variant when worst-severity has risen for
// `days` consecutive days (>= days). Labels say "if symptoms get worse" without a day
// count, so `days` is a fixed SUSTAINED-rise floor (2 = not a one-day blip).
export interface IllnessTrajectoryRule {
  days: number;
  line: string;
}

// A source-published stricter age band (the #798 "below the floor renders 'ask a
// doctor', not a number" pattern): when the profile's age is at or below `maxAgeMonths`,
// ANY logged day of this symptom (run >= 1) renders the refusal `line` (with its OWN
// `source`) instead of the adult duration count.
export interface IllnessInfantRule {
  maxAgeMonths: number;
  line: string;
  source: string;
}

export interface IllnessThresholdEntry {
  // Stable #799 symptom slug — the identity KEY (must be a curated slug; a custom
  // free-text symptom never has an entry).
  slug: string;
  label: string;
  duration?: IllnessDurationRule;
  trajectory?: IllnessTrajectoryRule;
  infantRule?: IllnessInfantRule;
  // The cited source for this entry's adult duration/trajectory lines.
  source: string;
}

// The validated dataset (envelope + guarantees). Throws at module load if the committed
// JSON ever violates the contract — a loud, early failure.
export const illnessThresholdsDataset =
  loadDataset<IllnessThresholdEntry>(rawIllness);

// Identity strategy: the #799 symptom `slug`, case-folded. For the framework linter.
export const illnessThresholdSlugStrategy = fieldStrategy("slug");

// Slug-keyed matcher (the framework refusal gate: an uncovered slug resolves to null).
const matcher = createMatcher(
  illnessThresholdsDataset,
  illnessThresholdSlugStrategy
);

// Every threshold entry in curated order.
export const ILLNESS_THRESHOLD_ENTRIES: IllnessThresholdEntry[] =
  illnessThresholdsDataset.entries;

// The cited threshold entry for a symptom slug, or null when the dataset doesn't cover
// it (framework accessor). NOTE: the DOMAIN accessor lib/illness-thresholds.ts keeps an
// EXACT-slug map lookup (behavior-preserving — stored keys are canonical slugs); this
// case-folding matcher is the framework registration surface.
export function illnessThresholdBySlug(
  slug: string
): IllnessThresholdEntry | null {
  return matcher.match(slug);
}
