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
import { BODY_HYGIENE_PREFIX } from "./weight-anomaly";
import { GOAL_PACE_PREFIX } from "./goal-pacing";
import { ADHERENCE_PREFIX } from "./adherence-patterns";

// Every namespace the rule-findings builders (buildTrainingObservationFindings,
// buildBodyHygieneFindings, buildGoalPacingFindings, buildAdherencePatternFindings)
// key their dedupeKeys under. Order is irrelevant; membership is what's guarded.
export const RULE_FINDING_PREFIXES: readonly string[] = [
  TRAINING_OBS_PREFIX,
  BODY_HYGIENE_PREFIX,
  GOAL_PACE_PREFIX,
  ADHERENCE_PREFIX,
];

// Whether a finding's dedupeKey belongs to a known builder namespace (so a page
// dismiss action's prefix guard can match it).
export function dedupeKeyHasKnownPrefix(key: string): boolean {
  return RULE_FINDING_PREFIXES.some((p) => key.startsWith(p));
}
