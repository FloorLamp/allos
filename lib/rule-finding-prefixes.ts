// The finding-producing builder registry (issue #448 → #860 Track A). Every finding a
// rule builder emits rides the shared findings-suppression bus keyed by its dedupeKey,
// each page's dismiss action guards a WHOLE domain with a single prefix check, and each
// finding travels a deliberate REACH TIER (#449: care = push/hero, coaching = calm). This
// module is the ONE registry binding those three facts together per namespace —
// **prefix + tier + reason source** — so:
//
//   • a builder that ships a dedupeKey outside these namespaces is un-guardable (its
//     dismiss action would never match) — the #448 reflection guard fails CI;
//   • a builder whose finding's tier the code doesn't match its registered tier — a new
//     coaching builder added to collectCoachingFindings but registered `care`, or vice
//     versa — fails CI (the tier reflection in rule-findings-builders.test.ts +
//     finding-registry-tiers.test.ts);
//   • a builder that attaches a #656 Reason whose `code` it didn't declare here fails CI
//     (the reason-source binding).
//
// The teeth mirror the source-scan guard precedents (telegram-chokepoint / profile-
// scoping / immediate-tx): the registry is data, the enforcement is a reflection test.
// A new findings engine adds ONE entry here (prefix + tier + declared reason codes) and
// its own fixture test — it cannot ship a finding without declaring how far it reaches.
//
// Pure (string constants + a type-only ReasonCode import), so it stays client-safe and
// importable from any tier — the dismiss actions and the notify tick both read it.

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
import { FIBER_ADEQUACY_PREFIX } from "./fiber";
import { ENDURANCE_PLAN_PREFIX } from "./endurance-plan";
import { ILLNESS_CARE_PREFIX } from "./illness-care";
import { TEMP_RED_FLAG_PREFIX } from "./temp-red-flag";
import { CONDITION_REVIEW_PREFIX } from "./condition-suggestions";
import { FOLLOWUP_PREFIX } from "./followup";
import { MENTAL_HEALTH_PREFIX } from "./mental-health";
import { FITNESS_CHECK_PREFIX } from "./fitness-retest";
import { MOBILITY_SUGGEST_PREFIX } from "./mobility-suggest";
import { MOOD_OBS_PREFIX, SLEEP_MOOD_PREFIX } from "./mood-observation";
import type { ReasonCode } from "./reasons";

// The two reach tiers (#449). CARE is push: Upcoming + the non-hideable Needs-attention
// hero + (where wired) the Telegram nudge. COACHING is calm: its own tab + the hideable
// dashboard rollup (collectCoachingFindings) — never a notification, never the hero.
export type FindingTier = "care" | "coaching";

// One registered finding namespace: the dedupeKey PREFIX its builder keys under, the
// reach TIER it travels, the BUILDER that emits it (for docs + test messages), and the
// closed set of #656 Reason CODES a finding under this prefix may carry (empty when the
// builder attaches no structured reason today — the common case).
export interface RuleFindingRegistryEntry {
  prefix: string;
  tier: FindingTier;
  builder: string;
  reasons: readonly ReasonCode[];
}

// The single source of truth. Every finding-producing builder in the codebase appears
// exactly once. COACHING members are precisely the builders aggregated by
// collectCoachingFindings (lib/rule-findings.ts); CARE members are the push builders that
// reach Upcoming/hero (illness-care, temp-red-flag, condition-review, follow-up) and are
// deliberately NOT in collectCoachingFindings. Order is irrelevant; membership + the
// three columns are what the guards read.
export const RULE_FINDING_REGISTRY: readonly RuleFindingRegistryEntry[] = [
  // ---- Coaching tier (calm; aggregated by collectCoachingFindings) -----------
  {
    prefix: TRAINING_OBS_PREFIX,
    tier: "coaching",
    builder: "buildTrainingObservationFindings",
    reasons: [],
  },
  {
    prefix: MUSCLE_VOLUME_PREFIX,
    tier: "coaching",
    builder: "buildMuscleVolumeFindings",
    reasons: [],
  },
  {
    prefix: BODY_HYGIENE_PREFIX,
    tier: "coaching",
    builder: "buildBodyHygieneFindings",
    reasons: [],
  },
  {
    prefix: GOAL_PACE_PREFIX,
    tier: "coaching",
    builder: "buildGoalPacingFindings",
    reasons: [],
  },
  {
    prefix: ADHERENCE_PREFIX,
    tier: "coaching",
    builder: "buildAdherencePatternFindings",
    reasons: [],
  },
  {
    prefix: FOOD_SUGGEST_PREFIX,
    tier: "coaching",
    builder: "buildFoodSuggestionFindings",
    reasons: [],
  },
  {
    prefix: FOOD_REDUCE_PREFIX,
    tier: "coaching",
    builder: "buildFoodSuggestionFindings",
    reasons: [],
  },
  {
    prefix: FOOD_HABIT_PREFIX,
    tier: "coaching",
    builder: "buildFoodHabitFindings",
    reasons: [],
  },
  {
    prefix: PROTEIN_ADEQUACY_PREFIX,
    tier: "coaching",
    builder: "buildProteinAdequacyFindings",
    reasons: [],
  },
  {
    // Fiber adequacy (#976): the calm DRI-based fiber observation, the protein pipeline
    // re-instantiated. COACHING tier (#449) — never a push, never the hero; it joins
    // collectCoachingFindings and rides the shared suppression bus keyed on the topic.
    prefix: FIBER_ADEQUACY_PREFIX,
    tier: "coaching",
    builder: "buildFiberAdequacyFindings",
    reasons: [],
  },
  {
    // Endurance event plans (#839): the calm weekly long-session nudge. COACHING tier
    // (#449) — never a push, never the hero; it joins collectCoachingFindings and rides
    // the shared suppression bus keyed on the discipline.
    prefix: ENDURANCE_PLAN_PREFIX,
    tier: "coaching",
    builder: "buildEndurancePlanFindings",
    reasons: [],
  },
  {
    prefix: SUN_EXPOSURE_PREFIX,
    tier: "coaching",
    builder: "buildSunExposureFindings",
    reasons: [],
  },
  {
    prefix: ORAL_HEALTH_PREFIX,
    tier: "coaching",
    builder: "buildOralHealthFindings",
    reasons: [],
  },
  {
    // Fitness-check retest cadence (#834): a calm "check due" nudge once a prior check
    // has aged past the per-profile cadence. Coaching tier — never a push (the issue's
    // "Upcoming" wording is superseded by #449's never-push requirement).
    prefix: FITNESS_CHECK_PREFIX,
    tier: "coaching",
    builder: "buildFitnessCheckFindings",
    reasons: [],
  },
  {
    // Mobility deficit→habit suggestions (#840 phase 2): a low sit-and-reach/balance
    // percentile or a recovering injury seeds a SUGGEST-ONLY mobility_region habit.
    // Coaching tier — calm, never a push, never a rehab prescription.
    prefix: MOBILITY_SUGGEST_PREFIX,
    tier: "coaching",
    builder: "buildMobilitySuggestionFindings",
    reasons: [],
  },
  {
    // Sustained low-mood observation (#992): a calm note from the daily wellbeing
    // check-ins. COACHING tier by hard product contract — mood is never a push,
    // never the hero, never escalated (no instrument prompt / crisis linkage from
    // the daily layer); it joins collectCoachingFindings and rides the shared bus.
    prefix: MOOD_OBS_PREFIX,
    tier: "coaching",
    builder: "buildMoodFindings",
    reasons: [],
  },
  {
    // Sleep↔mood co-occurrence bridge (#992): ONE calm note when a sustained
    // sleep-regularity/duration drop overlaps a low-mood window. Co-occurrence
    // phrasing only (never causal). COACHING tier — never a push, never the hero.
    prefix: SLEEP_MOOD_PREFIX,
    tier: "coaching",
    builder: "buildSleepMoodBridgeFindings",
    reasons: [],
  },
  // ---- Care tier (push; NOT in collectCoachingFindings) ----------------------
  {
    prefix: ILLNESS_CARE_PREFIX,
    tier: "care",
    builder: "buildIllnessCareFindings",
    reasons: [],
  },
  {
    prefix: TEMP_RED_FLAG_PREFIX,
    tier: "care",
    builder: "tempRedFlagItems",
    reasons: [],
  },
  {
    // Condition-suggestion review items (#685) — a care-tier, suggest-only builder.
    prefix: CONDITION_REVIEW_PREFIX,
    tier: "care",
    builder: "conditionReviewItems",
    reasons: [],
  },
  {
    // Finding follow-up chain items (#700) — a care-tier builder that carries a
    // `followup-source` legibility reason ("for the 6 mm RLL nodule").
    prefix: FOLLOWUP_PREFIX,
    tier: "care",
    builder: "followUpItems",
    reasons: ["followup-source"],
  },
  {
    // Mental-health crisis findings (#716) — a care-tier, NON-DISMISSIBLE signal (severe
    // PHQ-9/GAD-7 or a positive PHQ-9 item 9). It reaches Upcoming + the hero but is
    // deliberately NEVER pushed (omitted from the digest DOMAIN_SEQ, no notify
    // orchestrator), and is safety-ungated (the bus cannot hide it).
    prefix: MENTAL_HEALTH_PREFIX,
    tier: "care",
    builder: "mentalHealthCrisisItems",
    reasons: [],
  },
];

// Every namespace the finding builders key their dedupeKeys under (derived — the
// backward-compatible flat list the page dismiss guards + reflection guard have always
// read). Kept as a named export so existing consumers are unchanged.
export const RULE_FINDING_PREFIXES: readonly string[] =
  RULE_FINDING_REGISTRY.map((e) => e.prefix);

// The registry entry whose prefix a dedupeKey belongs to, or null when the key is in no
// known builder namespace. First match wins (prefixes are non-overlapping — pinned by
// the registry invariants test).
export function findingRegistryEntryFor(
  key: string
): RuleFindingRegistryEntry | null {
  return RULE_FINDING_REGISTRY.find((e) => key.startsWith(e.prefix)) ?? null;
}

// Whether a finding's dedupeKey belongs to a known builder namespace (so a page dismiss
// action's prefix guard can match it). Behavior unchanged from the #448 original.
export function dedupeKeyHasKnownPrefix(key: string): boolean {
  return RULE_FINDING_REGISTRY.some((e) => key.startsWith(e.prefix));
}

// The reach tier a finding travels (#449), by dedupeKey — or null when unregistered.
// The reflection guards assert a coaching-tier builder's keys resolve "coaching" and a
// care-tier builder's keys resolve "care", so a mis-declared tier fails CI.
export function tierForDedupeKey(key: string): FindingTier | null {
  return findingRegistryEntryFor(key)?.tier ?? null;
}

// The #656 Reason codes a finding under this dedupeKey is allowed to carry (empty when
// its builder declares none). The reflection guard asserts every Reason a builder
// attaches has a code in this set — a builder can't ship an undeclared reason source.
export function declaredReasonCodesFor(
  key: string
): readonly ReasonCode[] | null {
  return findingRegistryEntryFor(key)?.reasons ?? null;
}
