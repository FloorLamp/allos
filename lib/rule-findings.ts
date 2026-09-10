// The rule-findings COLLECTION REGISTRY (#2962).
//
// The domain builders live in ./rule-findings/*; what stays here is the thing they
// share and none of them owns: ONE `Finding` envelope (lib/findings), one declared
// collection order, the fan-out limits applied before suppression (./rule-findings/
// limits), and the closure snapshot. Each builder reads through already PROFILE-SCOPED
// queries + per-profile/-login settings, runs its pure detection, and maps the result
// into that envelope, so the page surfaces filter every domain through the one
// findings-bus suppression store (getFindingSuppressions + activeFindings) exactly
// alike. No owned SQL is added here or in any domain module, so the profile-scoping
// guard is unaffected.
//
// The re-exports below keep the historical `@/lib/rule-findings` import surface, the
// same arrangement lib/queries.ts has: a caller does not care which domain module a
// builder now lives in. Each builder still has exactly ONE implementation, in the
// module that owns its domain.
export * from "./rule-findings/limits";
export * from "./rule-findings/training";
export * from "./rule-findings/body-goals";
export * from "./rule-findings/nutrition";
export * from "./rule-findings/intake";
export * from "./rule-findings/rightsize";
export * from "./rule-findings/wellbeing";
export * from "./rule-findings/clinical";
export * from "./rule-findings/data-quality";

import { commitCached } from "./commit-cache";
import { DEFAULT_FORMAT_PREFS, type DisplayFormatPrefs } from "./format-date";
import { type WeightUnit } from "./settings";
import { type Finding } from "./findings";
import { DATA_QUALITY_PREFIX } from "./data-quality";
import { FITNESS_CHECK_PREFIX } from "./fitness-retest";
import { buildFoodDrugVarianceFindings } from "./food-drug-ledger-findings";
import { buildDataQualityFindings } from "./rule-findings/data-quality";
import {
  buildEndurancePlanFindings,
  buildFitnessCheckFindings,
  buildMobilitySuggestionFindings,
  buildMuscleVolumeFindings,
  buildTrainingObservationFindings,
} from "./rule-findings/training";
import {
  buildBodyHygieneFindings,
  buildGoalPacingFindings,
} from "./rule-findings/body-goals";
import {
  buildFiberAdequacyFindings,
  buildFoodHabitFindings,
  buildFoodSuggestionFindings,
  buildProteinAdequacyFindings,
  buildSubstanceUseFindings,
} from "./rule-findings/nutrition";
import {
  buildAdherencePatternFindings,
  buildDemotionSuggestionFindings,
  buildMedicationDuplicationFindings,
} from "./rule-findings/intake";
import { buildTargetRightSizeFindings } from "./rule-findings/rightsize";
import {
  buildMoodFindings,
  buildPairedObservationFindings,
  buildSleepClockSkewFindings,
  buildSleepMoodBridgeFindings,
} from "./rule-findings/wellbeing";
import {
  buildCycleBleedingFindings,
  buildOralHealthFindings,
  buildSunExposureFindings,
  buildTtcWorkupFindings,
} from "./rule-findings/clinical";

// ---- #449: the unified coaching-findings collection -------------------------

// The four observational domains below (training balance/plateau, body-metric
// hygiene, goal pacing, adherence patterns) are the #45 "coaching" reach tier: calm,
// observational FYIs — never a push, never dashboard Now. Each
// renders on its own tab today, so a stale-exercise or off-pace-goal finding a user
// never opens that tab for is invisible (issue #449). This ONE aggregator is the
// single computation the dashboard "Coaching observations" rollup AND the four tabs
// build over — every finding keeps its stable, namespace-guarded dedupeKey, so a
// dismiss on ANY surface silences it on ALL of them through the shared suppression bus
// ("dismiss once, silence everywhere"). Returns the raw union; the caller applies the
// findings-bus filter (activeFindings) exactly like each tab does. No owned SQL is
// added (it reads through the already profile-scoped builders), so the profile-scoping
// guard is unaffected.

// `prefs` (#1020): the viewer's date shape for the dates some finding texts embed
// (fitness-check, weight-anomaly) — the same threading precedent as `wu` for
// weights (#1019). Defaults keep login-less callers on the documented fixed shape.
// Memoized until the next commit (#5073) — the heaviest of the six gathers above the
// dashboard's first candidate. The day is already an argument; `prefs` is two closed
// unions and both join the key. NOT the suppression bus: `getFindingSuppressions` and
// `routineOrder` stay per request, so a dismissal taken since the last commit is still
// read fresh over this set. `closureFindingSnapshot` above is deliberately separate and
// unmemoized — it is read on BOTH sides of a write.
export const collectCoachingFindings = commitCached(
  "rule-findings.coaching",
  (
    profileId: number,
    today: string,
    wu: WeightUnit,
    prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
  ) => `${profileId}:${today}:${wu}:${prefs.timeFormat}:${prefs.dateFormat}`,
  collectCoachingFindingsUncached
);

// What the collection hands each builder. The four values are the collection's own
// arguments: a builder takes the ones it needs and ignores the rest, so an entry is a
// call and not an adapter.
export interface CoachingCollectionContext {
  profileId: number;
  today: string;
  wu: WeightUnit;
  prefs: DisplayFormatPrefs;
}

// ONE entry per domain builder in the collection.
export interface CoachingCollectionEntry {
  /**
   * The builder's name, spelled as `RULE_FINDING_REGISTRY` (lib/rule-finding-prefixes)
   * records it — so a caller that wants a SUBSET of the collection can select entries
   * by joining on the prefix registry's tier column rather than keeping a second list.
   */
  builder: string;
  run: (c: CoachingCollectionContext) => Finding[];
}

// THE COLLECTION ORDER, declared once and read by nothing else. It is data rather than
// a hard-coded concatenation so that the order is inspectable, and so a surface that
// must ask for part of the collection can filter these entries instead of growing a
// parallel list of builder calls that would drift from this one.
export const COACHING_COLLECTION: readonly CoachingCollectionEntry[] = [
  {
    builder: "buildMedicationDuplicationFindings",
    run: (c) => buildMedicationDuplicationFindings(c.profileId),
  },
  {
    builder: "buildTrainingObservationFindings",
    run: (c) => buildTrainingObservationFindings(c.profileId, c.today),
  },
  {
    builder: "buildMuscleVolumeFindings",
    run: (c) => buildMuscleVolumeFindings(c.profileId, c.today),
  },
  {
    builder: "buildBodyHygieneFindings",
    run: (c) => buildBodyHygieneFindings(c.profileId, c.today, c.wu, c.prefs),
  },
  {
    builder: "buildGoalPacingFindings",
    run: (c) => buildGoalPacingFindings(c.profileId, c.today),
  },
  {
    builder: "buildAdherencePatternFindings",
    run: (c) => buildAdherencePatternFindings(c.profileId, c.today),
  },
  {
    builder: "buildDemotionSuggestionFindings",
    run: (c) => buildDemotionSuggestionFindings(c.profileId, c.today),
  },
  {
    builder: "buildTargetRightSizeFindings",
    run: (c) => buildTargetRightSizeFindings(c.profileId, c.today),
  },
  {
    builder: "buildFoodSuggestionFindings",
    run: (c) => buildFoodSuggestionFindings(c.profileId),
  },
  {
    builder: "buildFoodHabitFindings",
    run: (c) => buildFoodHabitFindings(c.profileId),
  },
  {
    builder: "buildFoodDrugVarianceFindings",
    run: (c) => buildFoodDrugVarianceFindings(c.profileId, c.today),
  },
  {
    builder: "buildSubstanceUseFindings",
    run: (c) => buildSubstanceUseFindings(c.profileId),
  },
  {
    builder: "buildProteinAdequacyFindings",
    run: (c) => buildProteinAdequacyFindings(c.profileId),
  },
  {
    builder: "buildFiberAdequacyFindings",
    run: (c) => buildFiberAdequacyFindings(c.profileId),
  },
  {
    builder: "buildEndurancePlanFindings",
    run: (c) => buildEndurancePlanFindings(c.profileId, c.today),
  },
  {
    builder: "buildSunExposureFindings",
    run: (c) => buildSunExposureFindings(c.profileId, c.today),
  },
  {
    builder: "buildOralHealthFindings",
    run: (c) => buildOralHealthFindings(c.profileId),
  },
  {
    builder: "buildFitnessCheckFindings",
    run: (c) => buildFitnessCheckFindings(c.profileId, c.today, c.prefs),
  },
  {
    builder: "buildMobilitySuggestionFindings",
    run: (c) => buildMobilitySuggestionFindings(c.profileId, c.today),
  },
  {
    builder: "buildMoodFindings",
    run: (c) => buildMoodFindings(c.profileId, c.today),
  },
  {
    builder: "buildSleepMoodBridgeFindings",
    run: (c) => buildSleepMoodBridgeFindings(c.profileId, c.today),
  },
  {
    builder: "buildSleepClockSkewFindings",
    run: (c) => buildSleepClockSkewFindings(c.profileId, c.today),
  },
  {
    builder: "buildPairedObservationFindings",
    run: (c) => buildPairedObservationFindings(c.profileId, c.today),
  },
  {
    builder: "buildCycleBleedingFindings",
    run: (c) => buildCycleBleedingFindings(c.profileId, c.today),
  },
  {
    builder: "buildTtcWorkupFindings",
    run: (c) => buildTtcWorkupFindings(c.profileId, c.today),
  },
  // LAST (#1045): the structural data-quality gaps join this ONE coaching set (so a
  // decline rides the shared bus and silences every surface), behind the observational
  // domains. The dashboard page maps these gaps to their own statement candidates and
  // excludes them from coaching-observation candidates (#1533). This order still shapes
  // the coaching tab, which shows the complete finding census.
  {
    builder: "buildDataQualityFindings",
    run: (c) => buildDataQualityFindings(c.profileId),
  },
];

function collectCoachingFindingsUncached(
  profileId: number,
  today: string,
  wu: WeightUnit,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): Finding[] {
  const c: CoachingCollectionContext = { profileId, today, wu, prefs };
  return COACHING_COLLECTION.flatMap((entry) => entry.run(c));
}

// The finding snapshot for the closure loop (#1305): the builders whose findings a
// satisfier WRITE can plausibly clear, gathered for the DECLARED prefixes only. Prefix-
// scoped by construction — a satisfier declares 1–2 prefixes (never "all"), so only those
// builders run; each is a cheap, profile-scoped read. dedupeKeys are format-independent,
// so default date prefs are fine here. `withFindingClosure` (lib/finding-closure) calls
// this bracketing the write and diffs the active set pre/post. A new satisfier adds its
// prefix's builder to this dispatch (and declares the prefix at its action).
export function closureFindingSnapshot(
  profileId: number,
  prefixes: readonly string[],
  today: string
): Finding[] {
  const out: Finding[] = [];
  if (prefixes.includes(FITNESS_CHECK_PREFIX))
    out.push(...buildFitnessCheckFindings(profileId, today));
  if (prefixes.includes(DATA_QUALITY_PREFIX))
    out.push(...buildDataQualityFindings(profileId));
  return out;
}
