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
import { DEMOTION_PREFIX } from "./supplement-demotion";
import { RIGHTSIZE_PREFIX } from "./target-rightsize";
import { FOOD_SUGGEST_PREFIX, FOOD_REDUCE_PREFIX } from "./food-suggest";
import { FOOD_HABIT_PREFIX } from "./food-habit";
import {
  FOOD_DRUG_EVENT_PREFIX,
  FOOD_DRUG_VARIANCE_PREFIX,
} from "./food-drug-ledger";
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
import { SUBSTANCE_USE_PREFIX } from "./substance-use";
import { FITNESS_CHECK_PREFIX } from "./fitness-retest";
import { MOBILITY_SUGGEST_PREFIX } from "./mobility-suggest";
import { MOOD_OBS_PREFIX, SLEEP_MOOD_PREFIX } from "./mood-observation";
import { MED_DUP_PREFIX } from "./medication-family";
import { DATA_QUALITY_PREFIX } from "./data-quality";
import { CYCLE_BLEEDING_PREFIX } from "./cycle-observation";
import { TTC_WORKUP_PREFIX } from "./ttc";
import { POOR_SLEEP_OVERRIDE_PREFIX } from "./derived-situations";
import { DIGEST_TIME_PREFIX } from "./digest-time-suggestion";
import { SYNC_REQUEST_PREFIX } from "./sync-requests";
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
    // Adherence-based priority DEMOTION suggestions (#1505 part 2): a high/mandatory
    // SUPPLEMENT the user has effectively stopped taking is SUGGESTED for the `low`
    // tag — never auto-demoted (#559: priority is declared, not inferred). COACHING
    // tier by hard product contract: calm, hideable, and NEVER a notification —
    // nagging about a supplement someone has chosen not to take is the exact failure
    // this issue removes. Medications are excluded at the detector (kind decides, the
    // same boundary isPushedIntake draws), so poor med adherence stays a missed-dose
    // escalation question and never a priority one.
    prefix: DEMOTION_PREFIX,
    tier: "coaching",
    builder: "buildDemotionSuggestionFindings",
    reasons: [],
  },
  {
    // Frequency-target RIGHT-SIZING suggestions (#1670): a weekly floor the profile
    // has been under for four completed weeks — a wellness practice, a training
    // routine, or a food habit, all three of which declare their floor in the SAME
    // `frequency_targets` row — is SUGGESTED for the cadence they actually keep, or
    // for their domain's own no-expectation state. Never applied (#559: a declared
    // commitment is the user's, and only their tap changes it).
    //
    // COACHING tier by hard product contract, and one prefix for all three domains
    // because there is ONE detector: the tier decision, the suppression bus and the
    // guardability property are properties of the SIGNAL, which is identical across
    // them; only the wording and the surface differ. Its sole push presence is a
    // ride-along on the practice pace nudge that was already sending — it never
    // originates a message.
    prefix: RIGHTSIZE_PREFIX,
    tier: "coaching",
    builder: "buildTargetRightSizeFindings",
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
    // Food–drug VARIANCE (#2021): a week-over-week swing in a mapped food group against
    // an entry whose advice is "keep it steady" (vitamin K × warfarin). COACHING tier by
    // hard product contract (#449) — never a notification, never the hero: it is a trend
    // line over a hand-tapped log, and the advice it quotes is about consistency, not an
    // event to act on today. Joins collectCoachingFindings and rides the shared bus keyed
    // on item × rule, so a dismissal covers that pairing and recovery clears the finding
    // on its own.
    prefix: FOOD_DRUG_VARIANCE_PREFIX,
    tier: "coaching",
    builder: "buildFoodDrugVarianceFindings",
    reasons: [],
  },
  {
    // Substance-use over-target observation (#998): a calm, non-judgmental note when
    // this week's logged standard drinks exceed the user's own reduction target.
    // COACHING tier (#449) — never a notification, never the hero (substance data
    // stays off every push channel); joins collectCoachingFindings and rides the
    // shared suppression bus keyed on the substance. NO gamification: the builder
    // emits nothing under/at target — silence is the success state.
    prefix: SUBSTANCE_USE_PREFIX,
    tier: "coaching",
    builder: "buildSubstanceUseFindings",
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
  {
    // Medication therapeutic-duplication note (#1027): two or more ACTIVE meds
    // sharing an ingredient family ("Ibuprofen appears in 2 active medications").
    // COACHING tier (#449) — never a notification, never the hero (the protective
    // half is the family-wide redose/over-max math); joins collectCoachingFindings
    // and rides the shared suppression bus keyed on the derived family key.
    prefix: MED_DUP_PREFIX,
    tier: "coaching",
    builder: "buildMedicationDuplicationFindings",
    reasons: [],
  },
  {
    // Structural data-quality gaps (#1045): missing birthdate/sex/reproductive
    // status, unconfirmed RxCUIs, partial PhenoAge panel, failed extractions,
    // unreviewed risk factors. COACHING tier (#449) — never a notification, never
    // the hero (structural, one-time, completable prompts, never behavioral nagging).
    // Joins collectCoachingFindings and rides the shared suppression bus keyed on the
    // gap TYPE, so a decline silences it on BOTH the dedicated dashboard widget and
    // the coaching rollup.
    prefix: DATA_QUALITY_PREFIX,
    tier: "coaching",
    builder: "buildDataQualityFindings",
    reasons: [],
  },
  {
    // Prolonged-bleeding observation (#1682): a recorded period at or past
    // PROLONGED_PERIOD_DAYS bleeding days ("9 days of bleeding — worth discussing
    // with a clinician"). COACHING tier by hard product contract (#449) — never a
    // notification, never the hero: cycle carries no obligation (the attention
    // doctrine), and the write path deliberately STORES a long period rather than
    // refusing it, so the calm note is the whole response. Joins
    // collectCoachingFindings and rides the shared suppression bus keyed on the
    // period's start day, so a dismissal is per-period, never topic-wide.
    prefix: CYCLE_BLEEDING_PREFIX,
    tier: "coaching",
    builder: "buildCycleBleedingFindings",
    reasons: [],
  },
  {
    // Trying-to-conceive workup prompt (#1680): the standard 12-months (6 from age 35)
    // suggestion that a clinician conversation is the usual next step. COACHING tier by
    // hard product contract (#449) — never a notification, never the hero. TTC carries no
    // obligation (the attention doctrine), and a fertility timeline arriving as a push
    // would be the worst possible delivery for it. Joins collectCoachingFindings and rides
    // the shared suppression bus keyed on the DECLARED start, so a dismissal covers that
    // attempt and a later, separately declared one surfaces its own.
    prefix: TTC_WORKUP_PREFIX,
    tier: "coaching",
    builder: "buildTtcWorkupFindings",
    reasons: [],
  },
  {
    // Portal SYNC REQUESTS (#1757): "run the portal tool on the computer with Mom's
    // login". COACHING tier, and the constraint is the point — portal hygiene is never a
    // safety signal, so this gets NO dedicated send, EVER. Its whole reach is an
    // Upcoming item plus the digest line that item already produces (the ride-the-nag
    // corollary #1685 established for a broken sync: reaching only surfaces you must
    // open to see inverts the purpose of a feature whose job is to run without you).
    //
    // It is also deliberately kept off the non-hideable "Needs attention" hero, by
    // cardBandForItem's coaching exclusion — the one property that would make a calm
    // ask un-ignorable.
    //
    // NOT a rule-findings builder: the item is emitted by the Upcoming generator
    // `syncRequestItems`, so the collectCoachingFindings reflection guards never see it.
    // It is registered here because the KEY must be guardable and its tier declared —
    // the same reason the suppression-only poor-sleep override is.
    prefix: SYNC_REQUEST_PREFIX,
    tier: "coaching",
    builder: "syncRequestItems (Upcoming generator, lib/queries/upcoming)",
    reasons: [],
  },
  {
    // The digest TIME suggestion (#2217): the configured send time loses more often
    // than not against the measured sleep-arrival distribution, so the app proposes
    // the p90 and waits for a tap. COACHING tier by hard product contract — a
    // digest-timing observation is not a safety signal, so it is never an Upcoming
    // row, never the hero, never an escalation and NEVER ITS OWN SEND.
    //
    // Its one push presence is a ride-along line on the morning digest itself (owner
    // decision 2026-08-06), the same shape #1670's right-sizing suggestion has on the
    // practice nudge: a line added to an already-consented send is not an increase in
    // contact, and `buildDigest` appends it only to a message that already exists, so
    // it can never justify one.
    //
    // NOT a rule-findings builder: it is resolved per surface by
    // `activeDigestTimeSuggestion`, so collectCoachingFindings never sees it. It is
    // registered here for the same reason the portal sync ask and the poor-sleep
    // override are — the KEY must be guardable and the tier must be declared.
    prefix: DIGEST_TIME_PREFIX,
    tier: "coaching",
    builder: "activeDigestTimeSuggestion (lib/digest-time-suggestion.ts)",
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
    // Food–drug EVENT (#2021): a serving of a mapped group logged inside an active item's
    // rule window — the metronidazole × alcohol case the app used to watch in silence.
    // CARE tier: it belongs to the med-safety family (dietary-limit / interaction /
    // allergy-med) and the guidance is forward-looking (the label's own "and for 3 days
    // after"), so it reaches Upcoming + the non-hideable Needs-attention hero.
    //
    // A push channel is deliberately scoped OUT, the condition-review precedent: the tier
    // is a CEILING, not a floor (#1433), and the contact-consent rule requires a
    // user-owned declaration behind any increase in contact. The food log is an
    // observation domain — nobody promised the app anything by logging a drink — and a
    // message that arrived because you did would be surveillance-shaped, which is the
    // opposite of the posture that makes people log honestly. `food-drug-event` is
    // therefore omitted from the digest's DOMAIN_SEQ and has no notify orchestrator.
    prefix: FOOD_DRUG_EVENT_PREFIX,
    tier: "care",
    builder: "buildFoodDrugEventFindings / foodDrugEventItems",
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
  {
    // The poor-sleep derived-context "Not today" override (#1292). NOT a finding
    // builder — it is a date-scoped SUPPRESSION-ONLY key stored on the shared bus so
    // the override write action (dismissDerivedPoorSleep) passes the same
    // dedupeKeyHasKnownPrefix guard every dismiss action uses. Registered here (with a
    // display mapping in suppression-display) so it's guardable + restorable; no builder
    // emits it, so the reflection guards over builder OUTPUT never see it. COACHING tier
    // — the poor-sleep dueness widening is calm context, never a push/hero.
    prefix: POOR_SLEEP_OVERRIDE_PREFIX,
    tier: "coaching",
    builder: "dismissDerivedPoorSleep (suppression-only, no finding builder)",
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
