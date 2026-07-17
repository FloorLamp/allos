// The known dedupeKey prefix registry for the lib/rule-findings builders (issue
// #448). Every finding a builder emits rides the shared findings-suppression bus
// keyed by its dedupeKey, and each page's dismiss action guards a WHOLE domain with
// a single prefix check — so a builder that shipped a key outside these namespaces
// would be un-guardable (its dismiss action would never match). This is the single
// source of truth those guards and the DB-tier reflection test share: a new findings
// engine must add its prefix here, and the test (rule-findings-builders.test.ts)
// fails if any builder emits a key that doesn't parse against it.
//
// Pure (just string constants re-exported from the four engine modules), so it's
// client-safe and importable from any tier.

import { TRAINING_OBS_PREFIX } from "./training-observations";
import { MUSCLE_VOLUME_PREFIX } from "./muscle-volume-bands";
import { BODY_HYGIENE_PREFIX } from "./weight-anomaly";
import { GOAL_PACE_PREFIX } from "./goal-pacing";
import { ADHERENCE_PREFIX } from "./adherence-patterns";
import { FOOD_SUGGEST_PREFIX, FOOD_REDUCE_PREFIX } from "./food-suggest";
import { FOOD_HABIT_PREFIX } from "./food-habit";
import { SUN_EXPOSURE_PREFIX } from "./sun-exposure";
import { ORAL_HEALTH_PREFIX } from "./oral-health-observation";
import { PROTEIN_ADEQUACY_PREFIX } from "./protein";
import { ILLNESS_CARE_PREFIX } from "./illness-care";
import { TEMP_RED_FLAG_PREFIX } from "./temp-red-flag";
import { CONDITION_REVIEW_PREFIX } from "./condition-suggestions";
import { FOLLOWUP_PREFIX } from "./followup";

// Every namespace the rule-findings builders (buildTrainingObservationFindings,
// buildBodyHygieneFindings, buildGoalPacingFindings, buildAdherencePatternFindings,
// buildFoodSuggestionFindings, buildFoodHabitFindings, buildSunExposureFindings,
// buildOralHealthFindings, buildProteinAdequacyFindings, buildMuscleVolumeFindings) key
// their dedupeKeys under, PLUS the care-tier builders (#805 buildIllnessCareFindings
// and #685 conditionReviewItems — push/care members here, NOT coaching builders).
// Order is irrelevant; membership is what's guarded.
export const RULE_FINDING_PREFIXES: readonly string[] = [
  TRAINING_OBS_PREFIX,
  MUSCLE_VOLUME_PREFIX,
  BODY_HYGIENE_PREFIX,
  GOAL_PACE_PREFIX,
  ADHERENCE_PREFIX,
  FOOD_SUGGEST_PREFIX,
  FOOD_REDUCE_PREFIX,
  FOOD_HABIT_PREFIX,
  SUN_EXPOSURE_PREFIX,
  ORAL_HEALTH_PREFIX,
  PROTEIN_ADEQUACY_PREFIX,
  ILLNESS_CARE_PREFIX,
  TEMP_RED_FLAG_PREFIX,
  // Condition-suggestion review items (#685) — a care-tier, suggest-only builder
  // (conditionReviewItems), like illness-care not part of collectCoachingFindings.
  CONDITION_REVIEW_PREFIX,
  // Finding follow-up chain items (#700) — a care-tier builder (followUpItems),
  // like illness-care/condition-review a push/care member, NOT a coaching builder.
  FOLLOWUP_PREFIX,
];

// Whether a finding's dedupeKey belongs to a known builder namespace (so a page
// dismiss action's prefix guard can match it).
export function dedupeKeyHasKnownPrefix(key: string): boolean {
  return RULE_FINDING_PREFIXES.some((p) => key.startsWith(p));
}
