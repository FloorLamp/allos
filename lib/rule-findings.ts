// Server-side assembly for the deterministic rule domains added in issue #45
// (domains 4–6: training balance/plateau, body-metric data hygiene, goal pacing;
// domain 3: adherence pattern detection). Mirrors lib/trajectory-series.ts — each builder reads through already
// PROFILE-SCOPED queries + per-profile/-login settings, runs the pure detection
// (lib/training-observations, lib/weight-anomaly, lib/goal-pacing), and maps the
// results into the shared Finding envelope (lib/findings) so the page surfaces filter
// them through the one findings-bus suppression store (getFindingSuppressions +
// activeByKey) exactly like the trajectory/coaching/digest findings.
//
// Nothing here re-implements a slope or a projection — the plateau/loss checks reuse
// the robust helpers and goal pacing reuses projectGoal, so a finding and the chart
// caption it rides alongside can never disagree ("one question, one computation").
// No owned SQL is added here, so the profile-scoping guard is unaffected.

import {
  getStrengthByExercise,
  getExerciseSetCountsSince,
  getExerciseE1rmSeries,
  getWeights,
  getWeightsOneSourcePerDay,
  getBodyMetricDailySeries,
  getOutcomeGoals,
  getSupplements,
  getSupplementDoses,
  getIntakeLogsInRange,
  getActivityDates,
  getRecentDatedExercises,
  getFoodSuggestions,
  getFrequencyTargetProgress,
  getFrequencyTargetWeeklyHistory,
  getAllSubstanceWeekStates,
  getIntakeSafetyContext,
  getActiveMedicationFamilies,
  getBiomarkerSeries,
  getCanonicalBiomarker,
  getDaylightOutdoorMinutesTotal,
  getProteinAdequacy,
  getFiberAdequacy,
  getFindingSuppressions,
} from "./queries";
import { activeFindings } from "./findings";
import { exerciseHistoryKey } from "./lifts";
import type { MuscleRegion } from "./lifts";
import {
  getActiveSituations,
  getSituationEvents,
  getHomeLocation,
  getProfileSex,
  getProfileAge,
  getProfileReproductiveStatus,
  getSmokingHistory,
  getRiskAttributesReviewed,
  getTimezone,
} from "./settings";
import { isMinor } from "./life-stage";
import {
  getMedicationsMissingRxcuiCount,
  getMedicationMissingRxcuiSoleId,
  getFailedExtractionDocumentCount,
  getLatestMetricSample,
  getBioAgeReadings,
  hasImportedSmokingHistory,
  countPrescribersNeedingLink,
} from "./queries";
import { resolveSmoking } from "./smoking";
import { PHENOAGE_INPUT_COUNT, PHENOAGE_INPUT_NAMES } from "./bio-age";
import {
  detectDataQualityGaps,
  dataQualityDedupeKey,
  DATA_QUALITY_PREFIX,
  type DataQualityInputs,
  type DataQualityGap,
} from "./data-quality";
import { buildFoodDrugVarianceFindings } from "./food-drug-ledger-findings";
import { situationHistoryResolver } from "./trend-annotations";
import { getIntakeHistory } from "./intake-history";
import {
  detectDemotionCandidates,
  demotionItemIdFromKey,
  DEMOTION_WINDOW_DAYS,
  type DemotionInput,
} from "./supplement-demotion";
import { optimalStatus } from "./reference-range";
import { decideSunExposure, SUN_EXPOSURE_WINDOW_WEEKS } from "./sun-exposure";
import { prolongedBleedingObservations } from "./cycle-observation";
import { listCyclePeriods } from "./cycle-store";
import { decideWorkupPrompt } from "./ttc";
import { getTtcStart } from "./settings/profile-attrs";
import { getRiskAttributes } from "./settings";
import { isPrn } from "./supplement-schedule";
import { decidePeriodontalObservation } from "./oral-health-observation";
import {
  fitnessRetestDue,
  fitnessCheckSignalKey,
  FITNESS_CHECK_PREFIX,
} from "./fitness-retest";
import { getLatestFitnessAssessmentDate } from "./fitness-assessment";
import { getMobilitySuggestions } from "./queries/mobility";
import { getFitnessRetestCadenceDays } from "./settings";
import {
  deriveRiskFactors,
  EMPTY_RISK_ATTRIBUTES,
} from "./risk-stratification";
import { isGoalLive } from "./outcome-goals";
import { frequencyScopeLabel } from "./frequency-targets";
import { getRoutineCycleStatus } from "./routines";
import {
  foodHabitSignalKey,
  isFoodHabitBehind,
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "./food-habit";
import {
  substanceTargetSignalKey,
  capProgressLine,
  substanceDef,
} from "./substance-use";
import {
  proteinAdequacySignalKey,
  proteinAdequacyTitle,
  proteinAdequacyDetail,
  proteinAdequacyEvidence,
} from "./protein";
import {
  fiberAdequacySignalKey,
  fiberAdequacyTitle,
  fiberAdequacyDetail,
  fiberAdequacyEvidence,
} from "./fiber";
import {
  detectLowMoodWindow,
  decideSleepMoodBridge,
  meanNightlySleepMin,
  MOOD_LOW_WINDOW_DAYS,
  type LowMoodWindow,
} from "./mood-observation";
import { getMoodLogs, getMetricDailyTotals } from "./queries";
import { getSleepRegularity } from "./queries/sleep";
import { shiftDateStr, lastNDates } from "./date";
import { fmtWeight, round } from "./units";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "./format-date";
import { describeEta } from "./trend-projection";
import type { Finding } from "./findings";
import {
  readingDetailHref,
  nutritionTabHref,
  MEDICATIONS_HREF,
  PRACTICES_HREF,
  type AppRoute,
} from "./hrefs";
import {
  detectRightSizeCandidates,
  RIGHTSIZE_WEEKS,
  type RightSizeCandidate,
  type RightSizeDomain,
  type RightSizeInput,
} from "./target-rightsize";
import { medDupSignalKey, familyDisplayLabel } from "./medication-family";
import type { FoodSuggestion } from "./food-suggest";
import type { WeightUnit } from "./settings";
import {
  detectPushPullImbalance,
  detectStaleExercises,
  detectPlateaus,
  BALANCE_WINDOW_DAYS,
  PLATEAU_WINDOW_DAYS,
  type TrainingObservation,
} from "./training-observations";
import { plateauInlineHint } from "./plateau-advice";
import { coverageFromSets } from "./muscle-coverage";
import {
  detectVolumeShortfalls,
  countDistinctWeeks,
  VOLUME_BAND_WINDOW_DAYS,
  type VolumeBandObservation,
} from "./muscle-volume-bands";
import { getInjuryConstraints } from "./injuries";
import { excludedRegions } from "./injury-model";
import {
  enduranceLongSessionKey,
  enduranceLongSessionTitle,
  enduranceLongSessionDetail,
} from "./endurance-plan";
import { getEndurancePlanCards, getIllnessCoachingContext } from "./queries";
import {
  detectWeightAnomalies,
  weightAnomalySignalKey,
  type WeightAnomaly,
} from "./weight-anomaly";
import {
  biomarkerGoalCheckIn,
  biomarkerTargetOf,
  directionMet,
  labGoalHasCheckedIn,
} from "./biomarker-goal";
import { retestDaysForBiomarker } from "./biomarker-retest";
import { biomarkerPlots } from "./queries/biomarker-plot";
import { sameUnit } from "./unit-conversions";
import {
  assessGoalPace,
  detectFastWeightLoss,
  goalPaceSignalKey,
  weightLossRateSignalKey,
  weightLossRateLegacyKey,
  GOAL_PACE_WINDOW_DAYS,
} from "./goal-pacing";
import {
  detectAdherencePatterns,
  ADHERENCE_PATTERN_DAYS,
  type AdherencePattern,
  type DoseAdherenceInput,
} from "./adherence-patterns";
import {
  doseStrip,
  doseWindowSince,
  indexTakenByDose,
  stripWithoutTrailingPending,
} from "./supplement-adherence";
import {
  doseDueOn,
  doseSlotChangedSince,
  timeBucket,
} from "./supplement-schedule";
import { unrecordedScheduleChangeOn } from "./intake-cadence";

// ---- #449: the unified coaching-findings collection -------------------------

// The four observational domains below (training balance/plateau, body-metric
// hygiene, goal pacing, adherence patterns) are the #45 "coaching" reach tier: calm,
// observational FYIs — never a push, never the non-hideable Needs-attention hero. Each
// renders on its own tab today, so a stale-exercise or off-pace-goal finding a user
// never opens that tab for is invisible (issue #449). This ONE aggregator is the
// single computation the dashboard "Coaching observations" rollup AND the four tabs
// build over — every finding keeps its stable, namespace-guarded dedupeKey, so a
// dismiss on ANY surface silences it on ALL of them through the shared suppression bus
// ("dismiss once, silence everywhere"). Returns the raw union; the caller applies the
// findings-bus filter (activeFindings) exactly like each tab does. No owned SQL is
// added (it reads through the already profile-scoped builders), so the profile-scoping
// guard is unaffected.
// The Fitness-check retest nudge (#834): a calm coaching item once a prior check has
// aged past the per-profile cadence. Never nags a subject who has never done a check
// (hide, don't shame — #489); never a push (coaching tier). Re-keyed by the last-check
// date so a new check clears an old dismissal cleanly.
// `prefs` shapes the date embedded in the detail text only (#1020 — web finding
// strings render in the viewer's shape); the dedupeKey stays format-independent.
export function buildFitnessCheckFindings(
  profileId: number,
  today: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): Finding[] {
  const lastDate = getLatestFitnessAssessmentDate(profileId);
  const cadence = getFitnessRetestCadenceDays(profileId);
  const d = fitnessRetestDue(lastDate, cadence, today);
  if (!d.due || !d.lastDate) return [];
  const ago = d.daysSince != null ? ` (${d.daysSince} days ago)` : "";
  return [
    {
      domain: "fitness-check",
      dedupeKey: fitnessCheckSignalKey(d.lastDate),
      title: "Fitness check due",
      detail: `Your last fitness check was ${formatLongDate(d.lastDate, prefs)}${ago}. Re-run the battery to refresh your percentiles and see check-over-check change.`,
      tone: "info",
      evidence:
        "Informational — you set the retest cadence in Profile settings.",
      actionHref: "/training?tab=fitness" as AppRoute,
      actionLabel: "Start a check",
    },
  ];
}

// ---- Mobility deficit → habit suggestions (#840 phase 2) -------------------

// SUGGEST-ONLY mobility-region habit suggestions from measured deficits (#834 sit-and-
// reach / single-leg balance) or a #838 RECOVERING injury — the #577 "suggestions from
// your measurements" pattern applied to movement. Coaching tier ONLY (#449): joins
// collectCoachingFindings, rides the shared bus (MOBILITY_SUGGEST_PREFIX registered), NEVER
// notifies / never the hero, never a rehab prescription (the injury line is soft). One
// computation (mobilitySuggestions) shared with the Training-overview accept affordance so
// the finding and the one-tap button can never disagree. Regions already tracked as a
// mobility_region habit are skipped (the loop is closed once accepted, #580). No owned SQL.
export function buildMobilitySuggestionFindings(
  profileId: number,
  today: string
): Finding[] {
  void today; // no time-relative copy; kept for signature parity with siblings
  return getMobilitySuggestions(profileId).map((s) => ({
    domain: "mobility-suggest",
    dedupeKey: s.dedupeKey,
    title: s.title,
    detail: s.detail,
    tone: "info",
    evidence:
      "Suggestion from your fitness check / recovering injuries — track it as a weekly habit, or dismiss.",
    actionHref: "/training?tab=overview" as AppRoute,
    actionLabel: "Track it",
  }));
}

// ---- Medication therapeutic-duplication note (#1027 ask 3) ------------------

// ONE calm observation per ingredient FAMILY with two or more ACTIVE medication
// members ("Ibuprofen appears in 2 active medications") — the visibility half of the
// #1027 cross-item counters (the family-wide redose/over-max math is the protective
// half). COACHING tier deliberately (#449): it joins collectCoachingFindings, its
// dedupeKey (`med-dup:<familyKey>`, MED_DUP_PREFIX registered in
// RULE_FINDING_PREFIXES) rides the shared suppression bus, and it NEVER notifies /
// never reaches the hero — tracking both an OTC and an Rx strength is often
// deliberate, so this is informational posture only. Reads through the ONE
// profile-scoped family gather (getActiveMedicationFamilies), so the note and the
// widened counters can never disagree about what a family is. The familyKey is
// derived (CUI-first, cleaned-name fallback) — per #203, resolving/renaming a member
// re-keys the family and an old dismissal goes inert (it resurfaces once).
export function buildMedicationDuplicationFindings(
  profileId: number
): Finding[] {
  const findings: Finding[] = [];
  for (const family of getActiveMedicationFamilies(profileId)) {
    if (family.members.length < 2) continue;
    const label = familyDisplayLabel(family.members);
    findings.push({
      domain: "med-dup",
      dedupeKey: medDupSignalKey(family.familyKey),
      title: `${label} appears in ${family.members.length} active medications`,
      detail:
        `${family.members.map((m) => m.name).join(" + ")} share the same active ` +
        `ingredient, so their doses count together toward the redose window and ` +
        `daily max.`,
      tone: "info",
      evidence:
        "Informational — tracking an OTC and a prescription strength separately " +
        "is often deliberate; this note only makes the shared ingredient visible.",
      actionHref: MEDICATIONS_HREF,
      actionLabel: "View medications",
    });
  }
  return findings;
}

// ---- Structural data-quality gaps (#1045) ----------------------------------

// The builder for the structural data-quality gaps: it GATHERS the profile's
// structural inputs (the #448 builder shape) and hands them to the pure detectors
// (lib/data-quality.ts), then maps each gap into the shared Finding envelope. Reuses
// the EXISTING computations everywhere — lib/bio-age input-completeness (never a
// second bio-age math), resolveSmoking (the same tri-state the preventive gates read),
// getLatestMetricSample for height — so a gap and the surface it degrades can't
// disagree. COACHING tier ONLY (#449): it joins collectCoachingFindings, its dedupeKey
// (`data-quality:<gap>`, DATA_QUALITY_PREFIX registered) rides the shared suppression
// bus, and it NEVER notifies / never reaches the hero. STRUCTURAL, one-time gaps only
// — never behavioral nagging (the hard boundary in lib/data-quality's header). No owned
// SQL is added here (reads through profile-scoped queries), so the scoping guard holds.
// The ONE gather → detect for a profile's structural gaps, leverage-ranked. Shared by
// the dashboard widget/coaching finding (buildDataQualityFindings) and the household
// rollup (household/page.tsx), so every surface keys on the SAME gap model (one
// question, one computation). No owned SQL added (reads through profile-scoped queries).
export function collectDataQualityGaps(profileId: number): DataQualityGap[] {
  const bioAge = getBioAgeReadings(profileId);
  const smoking = resolveSmoking(
    getSmokingHistory(profileId),
    hasImportedSmokingHistory(profileId)
  );
  const sex = getProfileSex(profileId);
  const inputs: DataQualityInputs = {
    age: getProfileAge(profileId),
    sexKnown: sex !== null,
    sex,
    reproductiveStatusKnown: getProfileReproductiveStatus(profileId) !== null,
    heightKnown: getLatestMetricSample(profileId, "height_cm") !== null,
    smokingKnown: smoking.source !== null,
    medsMissingRxcui: getMedicationsMissingRxcuiCount(profileId),
    medMissingRxcuiId: getMedicationMissingRxcuiSoleId(profileId),
    prescribersNeedingLink: countPrescribersNeedingLink(profileId),
    phenoAgePresentCount: bioAge.presentInputs.length,
    phenoAgeMissingCount: PHENOAGE_INPUT_COUNT - bioAge.presentInputs.length,
    // The first missing analyte in checklist order — the #662 add-form prefill
    // target for the phenoage CTA (#1146). Null when the panel is complete.
    phenoAgeMissingPrimary:
      PHENOAGE_INPUT_NAMES.find((n) => !bioAge.presentInputs.includes(n)) ??
      null,
    failedExtractions: getFailedExtractionDocumentCount(profileId),
    riskAttributesReviewed: getRiskAttributesReviewed(profileId),
  };
  return detectDataQualityGaps(inputs);
}

export function buildDataQualityFindings(profileId: number): Finding[] {
  return collectDataQualityGaps(profileId).map((gap) => ({
    domain: "data-quality",
    dedupeKey: dataQualityDedupeKey(gap.key),
    title: gap.label,
    detail: gap.whyLine,
    // Calm, structural FYI — never an alarm, never a push (coaching tier).
    tone: "info",
    evidence: `Unblocks ${gap.leverage} ${gap.leverage === 1 ? "engine" : "engines"} once fixed.`,
    actionHref: gap.ctaHref,
    actionLabel: "Fix it",
  }));
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

// `prefs` (#1020): the viewer's date shape for the dates some finding texts embed
// (fitness-check, weight-anomaly) — the same threading precedent as `wu` for
// weights (#1019). Defaults keep login-less callers on the documented fixed shape.
export function collectCoachingFindings(
  profileId: number,
  today: string,
  wu: WeightUnit,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): Finding[] {
  return [
    ...buildMedicationDuplicationFindings(profileId),
    ...buildTrainingObservationFindings(profileId, today),
    ...buildMuscleVolumeFindings(profileId, today),
    ...buildBodyHygieneFindings(profileId, today, wu, prefs),
    ...buildGoalPacingFindings(profileId, today),
    ...buildAdherencePatternFindings(profileId, today),
    ...buildDemotionSuggestionFindings(profileId, today),
    ...buildTargetRightSizeFindings(profileId, today),
    ...buildFoodSuggestionFindings(profileId),
    ...buildFoodHabitFindings(profileId),
    ...buildFoodDrugVarianceFindings(profileId, today),
    ...buildSubstanceUseFindings(profileId),
    ...buildProteinAdequacyFindings(profileId),
    ...buildFiberAdequacyFindings(profileId),
    ...buildEndurancePlanFindings(profileId, today),
    ...buildSunExposureFindings(profileId, today),
    ...buildOralHealthFindings(profileId),
    ...buildFitnessCheckFindings(profileId, today, prefs),
    ...buildMobilitySuggestionFindings(profileId, today),
    ...buildMoodFindings(profileId, today),
    ...buildSleepMoodBridgeFindings(profileId, today),
    ...buildCycleBleedingFindings(profileId, today),
    ...buildTtcWorkupFindings(profileId, today),
    // Appended LAST (#1045): the structural data-quality gaps join this ONE coaching
    // set (so a decline rides the shared bus and silences every surface), behind the
    // observational domains. NOTE (#1533): the order is no longer load-bearing for the
    // dashboard rollup — the rollup now excludes families that have their own dashboard
    // widget (FINDING_DASHBOARD_HOME), so gaps don't render there at all while the Data
    // quality widget is on. This order still shapes the coaching TAB, which is the
    // legitimate catch-all and shows everything.
    ...buildDataQualityFindings(profileId),
  ];
}

// ---- Wellbeing (#992): the sustained low-mood observation ------------------

// The ONE low-mood detection both mood builders share (one question, one
// computation): the low-mood finding and the sleep↔mood bridge key on the same
// window verdict, so they can never disagree about whether mood "has been low".
function lowMoodWindowFor(
  profileId: number,
  today: string
): LowMoodWindow | null {
  const windowStart = shiftDateStr(today, -(MOOD_LOW_WINDOW_DAYS - 1));
  return detectLowMoodWindow(
    getMoodLogs(profileId, windowStart).map((m) => ({
      date: m.date,
      valence: m.valence,
    })),
    today,
    windowStart
  );
}

// A calm, coaching-tier observation when mood check-ins have trended low over a
// sustained window. Coaching tier ONLY (#449, product-decided in #992): it joins
// collectCoachingFindings, its dedupeKey rides the shared suppression bus
// (MOOD_OBS_PREFIX is registered in RULE_FINDING_PREFIXES), and it NEVER notifies
// / never reaches the hero. The copy is observational and non-diagnostic — no
// instrument prompt, no crisis linkage, no escalation of any kind (those belong
// to #716/#996, never the daily layer). No owned SQL added here (reads through
// the profile-scoped getMoodLogs).
export function buildMoodFindings(profileId: number, today: string): Finding[] {
  const low = lowMoodWindowFor(profileId, today);
  if (!low) return [];
  return [
    {
      domain: "mood-obs",
      dedupeKey: low.dedupeKey,
      title: low.title,
      detail: low.detail,
      // Calm FYI — a neutral observation from the user's own log, never an alarm.
      tone: "info",
      evidence:
        "From your own daily check-ins — a subjective self-rating, not a screen " +
        "or a diagnosis.",
      actionHref: "/trends#body",
      actionLabel: "View mood trend",
    },
  ];
}

// ---- Wellbeing (#992): the sleep↔mood co-occurrence bridge ------------------

// ONE coaching-tier finding when a sustained sleep-regularity/duration drop
// CO-OCCURS with the low-mood window above. Deliberately a CO-OCCURRENCE note —
// "the two often move together" — never a causal or directional claim (#992's
// design choice). Sleep inputs reuse the SAME computations the Trends sleep
// surfaces render: getSleepRegularity (the #160 SRI) at two anchors, and the
// sleep_min daily totals for the duration windows — no second sleep engine.
// Coaching tier ONLY (#449): joins collectCoachingFindings, SLEEP_MOOD_PREFIX is
// registered, never a notification, never the hero. No owned SQL added here.
export function buildSleepMoodBridgeFindings(
  profileId: number,
  today: string
): Finding[] {
  const low = lowMoodWindowFor(profileId, today);
  if (!low) return [];

  // SRI over the recent 28-night window vs the 28 nights before it (null when a
  // window lacks enough recorded nights — the pure decide gate handles nulls).
  const recentReg = getSleepRegularity(profileId, { asOf: today });
  const priorReg = getSleepRegularity(profileId, {
    asOf: shiftDateStr(today, -28),
  });

  // Mean nightly duration, recent 14 days vs the prior 14 — the same daily
  // totals series the body census sleep chart renders.
  const nights = getMetricDailyTotals(profileId, "sleep_min");
  const recentStart = shiftDateStr(today, -13);
  const priorEnd = shiftDateStr(today, -14);
  const priorStart = shiftDateStr(today, -27);

  const obs = decideSleepMoodBridge(
    {
      lowMood: low,
      recentSri: recentReg?.sri ?? null,
      priorSri: priorReg?.sri ?? null,
      recentAvgSleepMin: meanNightlySleepMin(nights, recentStart, today),
      priorAvgSleepMin: meanNightlySleepMin(nights, priorStart, priorEnd),
    },
    today.slice(0, 7)
  );
  if (!obs) return [];
  return [
    {
      domain: "sleep-mood",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm FYI — a pattern note from the user's own data, never an alarm.
      tone: "info",
      evidence:
        "Co-occurrence in your own data — sleep and mood often move together. " +
        "Not a causal claim and not a diagnosis.",
      actionHref: "/trends#body",
      actionLabel: "View trends",
    },
  ];
}

// ---- Endurance plans (#839): the calm weekly long-session nudge -------------

// A coaching-tier finding per active endurance plan whose scheduled LONG session for this
// week isn't logged yet. Reads through getEndurancePlanCards — the SAME plan/trajectory
// model the Training overview card and the recommendation arm format (one computation,
// #221) — so the finding and the card can never disagree. Coaching tier ONLY (#449): it
// joins collectCoachingFindings, its dedupeKey (ENDURANCE_PLAN_PREFIX, registered in
// RULE_FINDING_PREFIXES) rides the shared suppression bus keyed on the discipline, and it
// NEVER notifies / never reaches the hero. Held during an open illness episode (#837) —
// plan nagging pauses while the profile is sick.
export function buildEndurancePlanFindings(
  profileId: number,
  today: string
): Finding[] {
  if (getIllnessCoachingContext(profileId, today).openEpisode) return [];
  const out: Finding[] = [];
  for (const card of getEndurancePlanCards(profileId, today)) {
    // Only surface a long session that's scheduled AND not yet done this week.
    if (card.thisWeek.longSessionKm <= 0 || card.longSessionDone) continue;
    out.push({
      domain: "endurance",
      dedupeKey: enduranceLongSessionKey(card.plan.discipline),
      title: enduranceLongSessionTitle(card),
      detail: enduranceLongSessionDetail(card),
      // Calm forward-looking nudge — never an alarm, never a push.
      tone: "info",
      dueDate: card.plan.eventDate,
      actionHref: "/training",
      actionLabel: "View plan",
    });
  }
  return out;
}

// ---- Nutrition (#767): goal-scaled protein-adequacy observation ------------

// A calm, coaching-tier observation when this week's protein intake is BELOW the goal-
// scaled band. Reads through getProteinAdequacy — the SAME computation the /nutrition
// adequacy card formats — so the card and this finding can never disagree ("one question,
// one computation"). Coaching tier ONLY (#449): it joins collectCoachingFindings, its
// dedupeKey rides the shared suppression bus (PROTEIN_ADEQUACY_PREFIX is registered in
// RULE_FINDING_PREFIXES), and it NEVER notifies / never reaches the hero. Only the `below`
// verdict surfaces — an estimated basis is a FLOOR, so the copy hedges the shortfall
// (mirroring the #578 RDA-adequacy split) and never asserts a deficiency. No owned SQL is
// added here (reads through the profile-scoped gather).
export function buildProteinAdequacyFindings(profileId: number): Finding[] {
  const a = getProteinAdequacy(profileId);
  if (!a || a.status !== "below") return [];
  return [
    {
      domain: "protein-adequacy",
      dedupeKey: proteinAdequacySignalKey(),
      title: proteinAdequacyTitle(a),
      detail: proteinAdequacyDetail(a),
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence: proteinAdequacyEvidence(a),
      actionHref: "/nutrition",
      actionLabel: "Log servings",
    },
  ];
}

// ---- Nutrition (#976): DRI-scaled fiber-adequacy observation ---------------

// A calm, coaching-tier observation when this week's fiber intake is BELOW the DRI
// adequate-intake target. Reads through getFiberAdequacy — the SAME computation the
// /nutrition fiber-adequacy card formats — so the card and this finding can never disagree
// ("one question, one computation"). Coaching tier ONLY (#449): it joins
// collectCoachingFindings, its dedupeKey rides the shared suppression bus
// (FIBER_ADEQUACY_PREFIX is registered in RULE_FINDING_PREFIXES), and it NEVER notifies /
// never reaches the hero. Only the `below` verdict surfaces — a non-tracked basis is a
// FLOOR, so the copy hedges the shortfall and never asserts a deficiency. No owned SQL is
// added here (reads through the profile-scoped gather).
export function buildFiberAdequacyFindings(profileId: number): Finding[] {
  const a = getFiberAdequacy(profileId);
  if (!a || a.status !== "below") return [];
  return [
    {
      domain: "fiber-adequacy",
      dedupeKey: fiberAdequacySignalKey(),
      title: fiberAdequacyTitle(a),
      detail: fiberAdequacyDetail(a),
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence: fiberAdequacyEvidence(a),
      actionHref: "/nutrition",
      actionLabel: "Log servings",
    },
  ];
}

// ---- Oral health: diabetes↔periodontitis link (coaching tier only, #706) ----

// A calm, informational coaching finding for a profile with active diabetes: the
// bidirectional gum-health ↔ glycemic-control link, worth knowing alongside the
// (separately surfaced) tighter dental cadence. Coaching tier ONLY (#449): it joins
// collectCoachingFindings, its dedupeKey rides the shared suppression bus
// (ORAL_HEALTH_PREFIX is registered in RULE_FINDING_PREFIXES), and it NEVER notifies
// / never reaches the hero. "Has diabetes" is resolved through the SAME
// deriveRiskFactors engine the visit-cadence tightening uses, so the note and the
// tightened dental cadence key on one answer (one question, one computation). No
// owned SQL is added here (reads through the profile-scoped intake-safety gather).
export function buildOralHealthFindings(profileId: number): Finding[] {
  // Active conditions from the ONE shared intake-safety gather (#661).
  const conditions = getIntakeSafetyContext(profileId).conditions;
  const factors = deriveRiskFactors({
    familyConditions: [],
    activeConditions: conditions,
    attributes: EMPTY_RISK_ATTRIBUTES,
  });
  const obs = decidePeriodontalObservation({
    hasDiabetes: factors.has("diabetes"),
  });
  if (!obs) return [];
  return [
    {
      domain: "oral-health",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence:
        "Diabetes and periodontitis are bidirectionally linked (ADA / AAP).",
      actionHref: "/records/history/visits",
      actionLabel: "Dental care",
    },
  ];
}

// ---- Prolonged bleeding (#1682 fix b) --------------------------------------

// A calm note for a recorded period at or past PROLONGED_PERIOD_DAYS bleeding days.
// The write path deliberately STORES such a period unrefused — refusing it would make
// the app unable to record a genuine emergency — so the observation is how the app says
// what it noticed. COACHING tier by hard product contract (#449): it joins
// collectCoachingFindings, its dedupeKey (`cycle-bleeding:<period_start>`,
// CYCLE_BLEEDING_PREFIX registered) rides the shared suppression bus, and it NEVER
// notifies / never reaches the hero — cycle carries no obligation, and a body-state
// observation must never arrive as a push. Reads the SAME profile-scoped period history
// every cycle surface derives from (listCyclePeriods), so the note and the recorded row
// can't disagree about a period's length. No owned SQL added here.
export function buildCycleBleedingFindings(
  profileId: number,
  today: string
): Finding[] {
  return prolongedBleedingObservations(listCyclePeriods(profileId), today).map(
    (obs) => ({
      domain: "cycle-bleeding",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm, observational — never an alarm, never a push (coaching tier).
      tone: "info",
      evidence:
        "Recorded from your own period log — informational, not a diagnosis.",
      actionHref: "/medical/cycles",
      actionLabel: "View cycle log",
    })
  );
}

// ---- Trying-to-conceive workup prompt (#1680) ------------------------------

// A calm note once someone has been trying for the standard threshold — 12 months, or 6
// from age 35 — suggesting that a clinician conversation is the usual next step.
//
// COACHING tier by hard product contract (#449): it joins collectCoachingFindings, its
// dedupeKey (`ttc-workup:<declared start>`, TTC_WORKUP_PREFIX registered in
// RULE_FINDING_PREFIXES) rides the shared suppression bus, and it NEVER notifies and never
// reaches the non-hideable hero. TTC carries no obligation (the attention doctrine), and a
// fertility timeline arriving as a push would be the single worst place for it.
//
// Gated on the DECLARED start only — nothing here infers that someone is trying — and it
// goes silent during a pregnancy. The copy states elapsed time and the usual next step:
// no cause, no odds, no encouragement, no milestone (the #716/#992 sensitivity precedent).
// No owned SQL added here.
export function buildTtcWorkupFindings(
  profileId: number,
  today: string
): Finding[] {
  // Adult-only content, the same `!isMinor` line the other adult-topic surfaces use.
  if (isMinor(getProfileAge(profileId))) return [];
  const prompt = decideWorkupPrompt({
    ttcStart: getTtcStart(profileId),
    today,
    age: getProfileAge(profileId),
    pregnant: getRiskAttributes(profileId).pregnant,
  });
  if (!prompt) return [];
  return [
    {
      domain: "ttc-workup",
      dedupeKey: prompt.dedupeKey,
      title: prompt.title,
      detail: prompt.detail,
      tone: "info",
      evidence:
        "Counted from the start date you recorded — informational, not a diagnosis.",
      actionHref: "/medical/cycles",
      actionLabel: "View cycle log",
    },
  ];
}

// ---- Nutrition input (#580): behind-target food-habit observations --------

// One calm coaching finding per tracked food-habit target that's behind this week
// ("2 more servings of fatty fish to hit your weekly habit"). Progress is the shared
// getFrequencyTargetProgress (the #579 rollup, food_group branch) — one computation, no
// parallel count. dedupeKey is keyed on the group slug (food-habit:<slug>). Coaching
// tier only — no notification (the #245 bus-gating precedent would apply if a nudge is
// ever added, out of scope here). No owned SQL added here.
export function buildFoodHabitFindings(profileId: number): Finding[] {
  // Active medications from the ONE shared intake-safety gather (#661), so the "behind
  // this week" encouragement and any food–drug warning come from one computation and
  // can't disagree with the medication row (#661.3).
  const medications = getIntakeSafetyContext(profileId).medications;
  return getFrequencyTargetProgress(profileId)
    .filter(isFoodHabitBehind)
    .map((p) => {
      const label = frequencyScopeLabel("food_group", p.target.scope_value);
      const remaining = p.per_week - p.count;
      const notes = foodHabitInteractions(
        p.target.scope_value,
        medications
      ).map(foodHabitInteractionNote);
      const detail = [
        `${p.count} of ${p.per_week} servings so far — ${remaining} to go to hit your weekly ${label.toLowerCase()} habit.`,
        ...notes,
      ].join(" ");
      return {
        domain: "food-habit",
        dedupeKey: foodHabitSignalKey(p.target.scope_value),
        title: `${label} habit is behind this week`,
        detail,
        tone: "info" as const,
        actionHref: "/nutrition",
        actionLabel: "Log servings",
      };
    });
}

// ---- Substance use (#998/#1078): over-target reduction observations --------

// ONE calm, non-judgmental coaching finding PER SUBSTANCE whose logged units this
// week exceed the profile's own reduction target ("9 drinks logged this week — 2
// over your 7-drink weekly cap."). Iterates the substance catalog (#1078:
// alcohol + nicotine + cannabis) and reads through getAllSubstanceWeekStates —
// the SAME week-window + split-ledger rollup the substance surface renders — and
// formats via the shared capProgressLine, so the page and the finding can never
// disagree ("one question, one computation"). Coaching tier ONLY (#449): it joins
// collectCoachingFindings, each dedupeKey rides the shared suppression bus
// (SUBSTANCE_USE_PREFIX is registered in RULE_FINDING_PREFIXES, keyed per
// substance — #203 stable), and it NEVER notifies / never reaches the hero —
// substance data stays off every push channel. NO GAMIFICATION (#998, the #716
// contract): nothing fires under/at the target — no "on track!" note, no streaks,
// no milestones; silence is the success state. Nothing fires with no target set
// (the observation exists only against the user's OWN goal). No owned SQL added
// here (reads through the profile-scoped query layer).
export function buildSubstanceUseFindings(profileId: number): Finding[] {
  // The substance-use surface is adult-gated (#1174/#1279); never emit a coaching
  // finding that deep-links a known minor to a now-redirected route.
  if (isMinor(getProfileAge(profileId))) return [];
  const out: Finding[] = [];
  for (const state of getAllSubstanceWeekStates(profileId)) {
    if (!state.status || !state.status.over) continue;
    out.push({
      domain: "substance-use",
      dedupeKey: substanceTargetSignalKey(state.substance),
      title: `${substanceDef(state.substance).label} is over your weekly target`,
      detail: capProgressLine(state.status, state.substance),
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence: "Your own weekly reduction target.",
      actionHref: "/records/specialty/substance-use",
      actionLabel: "View intake",
    });
  }
  return out;
}

// ---- Nutrition output (#577): deterministic biomarker→food suggestions ------

// One coaching finding per safety-screened food suggestion. Informational, food-first
// (#576): "Because your … is low, here's a food source." The dedupeKey is family-keyed
// on the nutrient (food-suggest:<key>), so a dismiss covers the nutrient regardless of
// which flagged member is newest (#482). Reads through getFoodSuggestions (the ONE
// computation the biomarker detail page also formats), so a finding and the page card
// can never disagree ("one question, one computation"). No owned SQL here.
export function buildFoodSuggestionFindings(profileId: number): Finding[] {
  return getFoodSuggestions(profileId).map(foodSuggestionToFinding);
}

function foodSuggestionToFinding(s: FoodSuggestion): Finding {
  const reduce = s.direction === "reduce";
  const side = reduce ? "high" : "low";
  const because =
    s.triggeredBy.length > 0
      ? `Because your ${s.triggeredBy.join(", ")} ${s.triggeredBy.length > 1 ? "are" : "is"} ${side}`
      : reduce
        ? "Foods to reduce"
        : "Food sources";
  const foodLine = s.foods.map((f) => `${f.food} — ${f.serving}`).join(" ");
  const cautions = s.safetyNotes.map((n) => n.text);
  const detail = [because + ".", foodLine, ...cautions, s.caveat]
    .filter(Boolean)
    .join(" ");
  return {
    domain: "food-suggest",
    dedupeKey: s.dedupeKey,
    // Add vs reduce framing (#775): "Food for …" (eat more) vs "Cut back for …".
    title: reduce ? `Cut back for ${s.label}` : `Food for ${s.label}`,
    detail,
    // Calm, informational lifestyle guidance — never a red attention flag; the reduce
    // direction is coaching-tier too (#449), never a push/hero.
    tone: "info",
    evidence: `${s.evidence} Source: ${s.source}.`,
    actionHref: readingDetailHref(s.triggeredBy[0] ?? null),
    actionLabel: "View biomarker",
  };
}

// ---- Domain 4: training balance + plateau (Training → Overview) -----------

// The deep link a stale/plateau exercise finding points at — the Analyze tab focused
// on that exercise (same link coaching's strength recs use).
function exerciseHref(exercise: string): AppRoute {
  return `/training?tab=analyze&kind=strength&item=${encodeURIComponent(exercise)}`;
}

function trainingObservationToFinding(o: TrainingObservation): Finding {
  return {
    domain: `training-${o.kind}`,
    dedupeKey: o.key,
    // Honor a pre-#436 dismissal under the episode-less key (#436 dual-read).
    supersedes: o.legacyKey,
    title: o.title,
    detail: o.detail,
    // Stale is a neutral FYI (slate); an imbalance/plateau is worth acting on
    // (amber caution) — but all stay calm and observational.
    tone: o.kind === "stale" ? "info" : "caution",
    actionHref: o.exercise
      ? exerciseHref(o.exercise)
      : "/training?tab=overview",
    actionLabel: o.exercise ? "View exercise" : "View training",
  };
}

// Every training-balance finding for a profile: a push/pull volume imbalance over the
// trailing 4 weeks, stale exercises (in rotation but lapsed), and plateaued lifts
// (estimated-1RM flat ~6 weeks). Not suppression-filtered — the caller applies the
// shared findings-bus filter.
export function buildTrainingObservationFindings(
  profileId: number,
  today: string
): Finding[] {
  const stats = getStrengthByExercise(profileId);
  const since = shiftDateStr(today, -(BALANCE_WINDOW_DAYS - 1));
  const setCounts = getExerciseSetCountsSince(profileId, since);
  // detectPlateaus only inspects points within the trailing PLATEAU_WINDOW_DAYS, so
  // bound the (otherwise all-history) rep-bearing scan to that same window (#389).
  // byLoadContext (#1610): one series per (movement, registry implement), so a home
  // chest press and a hotel chest press are never averaged into one fabricated flat
  // slope — and their findings carry distinct dedupe keys, so dismissing one leaves
  // the other live.
  const e1rmSeries = getExerciseE1rmSeries(
    profileId,
    shiftDateStr(today, -PLATEAU_WINDOW_DAYS),
    undefined,
    { byLoadContext: true }
  );

  const observations: TrainingObservation[] = [];
  const imbalance = detectPushPullImbalance(setCounts);
  if (imbalance) observations.push(imbalance);
  observations.push(
    ...detectStaleExercises(
      stats.map((s) => ({
        exercise: s.exercise,
        sessions: s.sessions,
        lastDate: s.lastDate,
      })),
      today
    )
  );
  // Cross-reference the routine's mesocycle (#741): when its deload week is ≤2 weeks
  // away, the plateau finding points at that built-in light week instead of advising
  // an ad-hoc deload. Same ONE gather every deload surface reads.
  const cycle = getRoutineCycleStatus(profileId, today);
  const upcomingDeload =
    cycle && cycle.weeksUntilDeload <= 2
      ? { weeksUntilDeload: cycle.weeksUntilDeload }
      : null;
  observations.push(...detectPlateaus(e1rmSeries, today, upcomingDeload));

  return observations.map(trainingObservationToFinding);
}

// ---- #923: inline plateau hint for the activity form -----------------------

// One active (undismissed) plateau finding, reduced to what the activity-form's inline
// hint needs (#923): the plateaued lift's canonical exerciseHistoryKey (so the form
// matches it to the part being entered) plus the SAME dedupeKey/legacy key the
// Training-watch card uses — so a dismissal on the form and on the Training tab silence
// each other through the one suppression bus (#435/#436). No second engine and no second
// key namespace: this reuses detectPlateaus and its `training-obs:plateau:…` key exactly.
export interface PlateauFormHint {
  exerciseKey: string;
  // The LOAD CONTEXT the plateau was measured in (#1610) — the registry equipment id,
  // or null for the unassigned lane. The form matches BOTH this and exerciseKey, so
  // selecting the hotel machine doesn't inherit the home machine's plateau hint.
  equipmentId: number | null;
  dedupeKey: string;
  supersedes: string;
  // The rendered one-liner (#1203) — the SHARED plateau-break advice (same ~10%
  // deload magnitude + named variations as the finding/next-set surfaces), built by
  // the one-computation helper so the inline hint is a pure formatter over it.
  hintText: string;
}

// The active plateau hints for a profile (#923). Runs the SAME plateau detection +
// deload cross-reference as buildTrainingObservationFindings, filters through the shared
// findings-bus suppression store (so a dismissed plateau doesn't hint here either), and
// keys each surviving plateau by exerciseHistoryKey. No owned SQL is added (reads through
// the profile-scoped e1RM/cycle gathers), so the profile-scoping guard is unaffected.
export function buildActivePlateauHints(
  profileId: number,
  today: string
): PlateauFormHint[] {
  const e1rmSeries = getExerciseE1rmSeries(
    profileId,
    shiftDateStr(today, -PLATEAU_WINDOW_DAYS),
    undefined,
    { byLoadContext: true }
  );
  const cycle = getRoutineCycleStatus(profileId, today);
  const upcomingDeload =
    cycle && cycle.weeksUntilDeload <= 2
      ? { weeksUntilDeload: cycle.weeksUntilDeload }
      : null;
  const observations = detectPlateaus(e1rmSeries, today, upcomingDeload);
  const active = activeFindings(
    observations.map(trainingObservationToFinding),
    getFindingSuppressions(profileId),
    today
  );
  const activeKeys = new Set(active.map((f) => f.dedupeKey));
  return observations
    .filter((o) => o.exercise && activeKeys.has(o.key))
    .map((o) => ({
      exerciseKey: exerciseHistoryKey(o.exercise!),
      equipmentId: o.equipmentId,
      dedupeKey: o.key,
      supersedes: o.legacyKey,
      hintText: plateauInlineHint(o.exercise!),
    }));
}

// ---- Domain 4b: per-muscle weekly volume bands (Training → Overview, #742) --

// Deload hook (#741, activating the #742 guard). During an active routine's DELOAD
// week the `below` volume observation is held — the week is supposed to be light —
// via the SAME week-in-cycle flag every deload surface reads (the ONE gather
// getRoutineCycleStatus, not per surface). No call-site change from the #742 guard:
// it now returns true on the routine's deload week instead of always false.
function isRoutineDeloadWeek(profileId: number, today: string): boolean {
  return getRoutineCycleStatus(profileId, today)?.isDeloadWeek ?? false;
}

function volumeObservationToFinding(o: VolumeBandObservation): Finding {
  return {
    domain: "muscle-volume",
    dedupeKey: o.key,
    title: o.title,
    detail: o.detail,
    // Calm, observational FYI — never a push, never the Needs-attention hero (#449).
    tone: "info",
    actionHref: "/training?tab=overview",
    actionLabel: "View coverage",
  };
}

// Every per-muscle volume-band shortfall finding for a profile: one calm observation
// per muscle trained BELOW its weekly band floor over the trailing 7 days. Reads
// through the SAME getRecentDatedExercises gather + coverageFromSets attribution the
// Overview coverage list renders (one computation, #221/#482) — the list's verdict
// chips and this finding can never disagree. Cold start (#719) and the guarded deload
// hook (#741) are decided HERE in the one gather. Not suppression-filtered — the
// caller applies the shared findings-bus filter. No owned SQL added (reads through the
// profile-scoped getRecentDatedExercises).
export function buildMuscleVolumeFindings(
  profileId: number,
  today: string
): Finding[] {
  // ONE scan: the same recent (date, exercise) rows the Overview coverage list uses.
  const datedExercises = getRecentDatedExercises(profileId);
  // Weekly per-muscle credited sets — the SAME attribution the list renders.
  const coverage = coverageFromSets(
    datedExercises,
    today,
    VOLUME_BAND_WINDOW_DAYS
  );
  const inputs = [...coverage.entries()].map(([muscle, c]) => ({
    muscle,
    sets: c.sets,
  }));
  // Cold-start signal: distinct strength-training weeks in the trailing scan.
  const historyWeeks = countDistinctWeeks(datedExercises.map((d) => d.date));
  return detectVolumeShortfalls(inputs, {
    historyWeeks,
    deloadActive: isRoutineDeloadWeek(profileId, today),
    monthAnchor: today.slice(0, 7), // YYYY-MM episode anchor (#436)
    // Active-injury region exclusion (#838): a shortfall for an off-limits region is noise
    // while it's out. The SAME injury constraints the recommendation model excludes on.
    excludedRegions: excludedRegions(getInjuryConstraints(profileId)),
  }).map(volumeObservationToFinding);
}

// ---- Domain 5: body-metric data hygiene (Trends → Overview → body census) -------------------

function weightAnomalyToFinding(
  a: WeightAnomaly,
  wu: WeightUnit,
  prefs: DisplayFormatPrefs
): Finding {
  const pct = Math.abs(round(a.changeFraction * 100, 1));
  const dir = a.changeFraction > 0 ? "up" : "down";
  const cur = fmtWeight(a.weightKg, wu);
  const prev = fmtWeight(a.prevWeightKg, wu);
  const detail = a.suspectedUnitError
    ? `On ${formatLongDate(a.date, prefs)} you logged ${cur}, ${pct}% ${dir} from ` +
      `${prev} on ${formatLongDate(a.prevDate, prefs)} — that looks like a kg/lb entry ` +
      `mix-up. Fixing or converting it keeps your weight trend honest.`
    : `On ${formatLongDate(a.date, prefs)} you logged ${cur}, ${pct}% ${dir} from ` +
      `${prev} on ${formatLongDate(a.prevDate, prefs)} — a jump that big over just a ` +
      `few days is usually a scale glitch. Check the entry and fix or delete it.`;
  return {
    domain: "body-hygiene",
    dedupeKey: weightAnomalySignalKey(a.id),
    title: "Unusual weight reading",
    detail,
    tone: "caution",
    evidence: a.suspectedUnitError
      ? "Possible kg/lb mix-up"
      : "Possible scale glitch",
    actionHref: "/trends#body",
    actionLabel: "Review in Body metrics",
  };
}

// Every body-metric hygiene finding for a profile: probable-error day-over-day weight
// jumps. `wu` renders the weights in the login's unit.
export function buildBodyHygieneFindings(
  profileId: number,
  today: string,
  wu: WeightUnit,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): Finding[] {
  // ONE source per day (id preserved), not the raw all-source getWeights rows: two
  // scales landing the same/adjacent day would otherwise feed the day-over-day
  // detector a false cross-source "jump", and the finding would link to a Trends →
  // Body chart (one source/day) that never shows the flagged value (#634 — the
  // cross-source half of #434).
  const weights = getWeightsOneSourcePerDay(profileId).map((w) => ({
    id: w.id,
    date: w.date,
    weightKg: w.weight_kg,
  }));
  return detectWeightAnomalies(weights, today).map((a) =>
    weightAnomalyToFinding(a, wu, prefs)
  );
}

// ---- Domain 6: goal pacing (Training → Goals) -----------------------------

// Every goal-pacing finding for a profile: body-metric goals that are off pace for
// their target date, plus a single safe-rate caution when weight is dropping faster
// than ~1%/week. Both reuse projectGoal / the robust slope over the weight series
// (kept in canonical kg — the finding reports days-late and a percentage, not a
// weight, so no unit conversion is needed).
export function buildGoalPacingFindings(
  profileId: number,
  today: string
): Finding[] {
  const findings: Finding[] = [];

  // The profile's goals, read ONCE for both loops below (they used to re-query the
  // same list) — nothing here writes, so the two passes always saw one snapshot.
  const goals = getOutcomeGoals(profileId);

  // Weight readings in canonical kg, ascending, as projection input. The SAME
  // primary-source-collapsed daily series (one row/day, #14) the Trends → Overview → body census
  // chart caption charts — not the raw all-source getWeights rows — windowed to the
  // shared GOAL_PACE_WINDOW_DAYS so the finding and the caption run projectGoal over
  // identical points and can't disagree (#433). getBodyMetricDailySeries already
  // returns oldest→newest.
  const windowStart = shiftDateStr(today, -(GOAL_PACE_WINDOW_DAYS - 1));
  const weightPoints = getBodyMetricDailySeries(profileId, "weight").filter(
    (p) => p.date >= windowStart
  );

  // Off-pace body-metric goals. Only weight goals have a metric series here
  // (getWeights); body-fat / resting-HR goals would need their own series and are a
  // documented follow-up, so we pace weight goals — the common case.
  for (const g of goals) {
    if (
      !isGoalLive(g) ||
      g.body_metric !== "weight" ||
      g.target_value == null ||
      g.target_date == null
    )
      continue;
    const pace = assessGoalPace(
      {
        id: g.id,
        title: g.title,
        targetValue: g.target_value,
        targetDate: g.target_date,
        baselineValue: g.baseline_value,
      },
      weightPoints
    );
    if (!pace) continue;
    const hedge = pace.confidence === "low" ? " (rough estimate)" : "";
    const detail =
      pace.status === "away"
        ? `At your current pace you're trending away from this goal — consider ` +
          `adjusting the target date or your plan.${hedge}`
        : `At your current pace you'll reach it ${describeEta(-pace.daysLate!)} — ` +
          `consider moving the target date or adjusting the plan.${hedge}`;
    findings.push({
      domain: "goal-pace",
      dedupeKey: goalPaceSignalKey(pace.goalId),
      title: `“${pace.title}” is off pace`,
      detail,
      tone: "caution",
      actionHref: "/training?tab=goals",
      actionLabel: "Review goal",
    });
  }

  // Off-pace BIOMARKER goals (#1853). Same builder, same `goal-pace:` namespace, same
  // dismiss action and therefore the same COACHING tier — a lab goal drifting is an
  // observation about a plan, not a safety signal, so it must not reach Upcoming, the
  // Needs-attention hero or a notification, and adding it here rather than to a new
  // prefix is what guarantees that (docs/internals/findings.md).
  //
  // The verdict itself is `assessGoalPace` over `projectGoal` — the SAME projection
  // the body goals above and the Trends chart captions run — fed the analyte's own
  // charted series, so the finding and the chart cannot disagree.
  //
  // The GATE is what differs: a lab goal is only assessed once a result has landed
  // since it was created (`labGoalHasCheckedIn`). A goal that has not been drawn since
  // the user set it has nothing to be off pace about, and firing on the clock would
  // hand someone a "you're behind" they could do nothing about on a day when nothing
  // was measured. That is also why there is no daily re-fire: the finding changes when
  // a tube is drawn.
  //
  // Every targeted analyte's plot is gathered in ONE pass (#1961) — the dashboard runs
  // this builder on every render, and a per-goal `biomarkerPlot` re-queried the series
  // and re-read the profile's demographics once per goal. The candidate list is
  // filtered by the CHEAP gates first, so an archived or undated goal still costs
  // nothing, and the emission loop below keeps the original goal order.
  const bmCandidates = goals.flatMap((g) => {
    if (!isGoalLive(g) || g.target_date == null) return [];
    const target = biomarkerTargetOf(g);
    return target ? [{ g, target, targetDate: g.target_date }] : [];
  });
  const bmPlots = biomarkerPlots(
    profileId,
    bmCandidates.map((x) => x.target.name)
  );
  for (const { g, target, targetDate } of bmCandidates) {
    const plot = bmPlots.get(target.name) ?? null;
    if (!plot || !sameUnit(target.unit, plot.unit)) continue;
    const latest = plot.points.at(-1) ?? null;
    if (!labGoalHasCheckedIn(g.created_at, latest?.date ?? null)) continue;
    // Already on the wanted side of the number — nothing to pace.
    if (latest && directionMet(target.direction, latest.value, target.value))
      continue;
    const pace = assessGoalPace(
      {
        id: g.id,
        title: g.title,
        targetValue: target.value,
        targetDate,
        baselineValue: target.baselineValue,
      },
      plot.points
    );
    if (!pace) continue;
    const hedge = pace.confidence === "low" ? " (rough estimate)" : "";
    const cadence = biomarkerGoalCheckIn(
      latest?.date ?? null,
      retestDaysForBiomarker(target.name),
      today
    );
    const nextDraw = cadence.dueDate
      ? cadence.due
        ? " Your next result for it is due."
        : ` Your next result for it is due around ${cadence.dueDate}.`
      : "";
    const detail =
      pace.status === "away"
        ? `Your recent results for ${target.name} are moving away from this ` +
          `target — consider adjusting the date or the plan with your ` +
          `clinician.${hedge}${nextDraw}`
        : `At the trend across your recent results you'd reach it ` +
          `${describeEta(-pace.daysLate!)} — consider moving the target date or ` +
          `revisiting the plan.${hedge}${nextDraw}`;
    findings.push({
      domain: "goal-pace",
      dedupeKey: goalPaceSignalKey(pace.goalId),
      title: `“${pace.title}” is off pace`,
      detail,
      tone: "caution",
      actionHref: "/training?tab=goals",
      actionLabel: "Review goal",
    });
  }

  // Safe-rate caution — one per profile, independent of any goal.
  const loss = detectFastWeightLoss(weightPoints, today);
  if (loss) {
    const pct = round(loss.fractionPerWeek * 100, 1);
    findings.push({
      domain: "goal-pace",
      dedupeKey: weightLossRateSignalKey(loss.sinceMonth),
      // Honor a pre-#436 dismissal under the episode-less key (#436 dual-read).
      supersedes: weightLossRateLegacyKey(),
      title: "Losing weight quickly",
      detail:
        `You're down about ${pct}%/week lately — faster than the ~1%/week that ` +
        `best preserves muscle. Easing off a little protects lean mass and makes ` +
        `the loss easier to sustain.`,
      tone: "caution",
      actionHref: "/trends#body",
      actionLabel: "See weight trend",
    });
  }

  return findings;
}

// ---- Domain 3: adherence pattern detection (Supplements & Meds) ------------

// An adherence-pattern observation → the shared Finding envelope. Calm/observational
// ("info" tone, like a stale-exercise FYI), deep-linking to the medicine page where
// the dose can be re-timed.
function adherencePatternToFinding(p: AdherencePattern): Finding {
  return {
    domain: `adherence-${p.kind}`,
    dedupeKey: p.key,
    // Honor a pre-#436 dismissal under the episode-less key (#436 dual-read).
    supersedes: p.legacyKey,
    title: p.title,
    detail: p.detail,
    tone: "info",
    actionHref: nutritionTabHref("supplements"),
    actionLabel: "View schedule",
  };
}

// Every adherence-pattern finding for a profile: scheduled doses whose misses
// cluster on a specific weekday ("most Fridays") or on weekends, each suggesting a
// concrete schedule edit. Reuses the same doseStrip / isDueOn machinery the medicine
// page's adherence strip is built from (one question, one computation) over a longer
// ADHERENCE_PATTERN_DAYS window, so a pattern and the strip it summarizes can't
// disagree. PRN/paused items and retired doses are excluded (they're never
// scheduled-due). Not suppression-filtered — the caller applies the shared
// findings-bus filter. No owned SQL is added here (it reads through profile-scoped
// queries), so the profile-scoping guard is unaffected.
export function buildAdherencePatternFindings(
  profileId: number,
  today: string
): Finding[] {
  const supplements = getSupplements(profileId);
  const suppById = new Map(supplements.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId);
  // The profile's timezone resolves the UTC creation stamps onto the same profile-local
  // calendar the `dates` window is built from (#1442).
  const tz = getTimezone(profileId);
  const takenByDose = indexTakenByDose(
    getIntakeLogsInRange(profileId, ADHERENCE_PATTERN_DAYS)
  );
  const dates = lastNDates(today, ADHERENCE_PATTERN_DAYS);
  const workoutDays = new Set(getActivityDates(profileId));
  // Per-day situation resolver (#654): a past day is scored against the situations
  // active THAT day, not today's toggle applied retroactively — so a situational
  // item's pattern observations aren't distorted by a situation activated today.
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );

  const inputs: DoseAdherenceInput[] = [];
  for (const d of doses) {
    const supp = suppById.get(d.item_id);
    // Only active, scheduled (non-PRN) items produce due days to miss.
    if (!supp || !supp.active || isPrn(supp)) continue;
    const status = takenByDose.get(d.id);
    // Clamp the window to the dose's EXISTENCE, and to nothing else (#1973).
    //
    // It used to be clamped at the dose's `updated_at` as well (#430), which meant any
    // re-time voided every day before it: the "editing a dose must not rewrite adherence
    // history" invariant was being honoured by throwing the history away. Effective-dated
    // schedules (migration 151) removed the need — `doseDueOn` below resolves the version
    // in force on each day, so a pre-edit day is judged by the pre-edit rule instead of
    // being dropped. What remains is the genuinely different question of when the dose
    // existed at all, and `doseWindowSince` is its better answer: timezone-aware, and
    // WIDENED by logged history, because a log is proof the dose existed on its date
    // (#1442). It is the same bound the adherence strip clamps to, so a pattern and the
    // strip it summarizes still cannot disagree about a day (#221).
    const exists = doseWindowSince(supp.created_at, d.created_at, status, tz);
    // …plus the ONE case effective-dating cannot reach: a dose re-timed BEFORE #1973
    // shipped, whose old slot no version records. `updated_at` says a change happened
    // but not what it replaced, so those days cannot be judged — and judging them by
    // today's rule would be the retroactive re-accusation #430 clamped to avoid. The
    // conservative bound stays for exactly those doses, and only until their next
    // schedule edit records a real version (see unrecordedScheduleChangeOn).
    const unrecorded = unrecordedScheduleChangeOn(d);
    const since = [exists, unrecorded]
      .filter((v): v is string => v != null)
      .reduce<string | null>((a, b) => (a == null || b > a ? b : a), null);
    const windowDates = since ? dates.filter((date) => date >= since) : dates;
    const strip = stripWithoutTrailingPending(
      doseStrip(
        windowDates,
        (date) =>
          doseDueOn(supp, d, {
            date,
            isWorkoutDay: workoutDays.has(date),
            activeSituations: situationsOn(date),
          }),
        status?.taken ?? new Set(),
        status?.skipped ?? new Set()
      )
    );
    inputs.push({
      doseId: d.id,
      supplementName: supp.name,
      bucket: timeBucket(d.time_of_day),
      strip,
      // Episode anchor = the current year (#436): a same-weekday habit that recurs a
      // year after being dismissed lands in a new period and re-surfaces, rather than
      // one dismissal silencing it forever.
      periodAnchor: today.slice(0, 4),
      // "Move it earlier" is wrong advice for a bedtime slot or a prescribed
      // medication (#430.4) — fall back to the neutral reminder copy. It is equally
      // wrong for a dose the person ALREADY MOVED inside this window (#1973): the days
      // now stay in the window and are judged honestly by the slot they sat in, but
      // telling someone to move a dose they re-timed last Tuesday is the re-accusation
      // #430 clamped the whole window to avoid. Suppressing the suggestion is the
      // proportionate answer; erasing the history was not.
      suppressMoveSuggestion:
        timeBucket(d.time_of_day) === "Before sleep" ||
        supp.kind === "medication" ||
        (windowDates.length > 0 && doseSlotChangedSince(d, windowDates[0])),
    });
  }

  return detectAdherencePatterns(inputs).map(adherencePatternToFinding);
}

// ---- Domain: priority demotion suggestions (coaching tier, issue #1505) ----

// A calm, dismissible SUGGESTION that a high/mandatory SUPPLEMENT the profile has
// effectively stopped taking be re-tagged `low` — "tracked, never pushed" — with the
// user's tap as the only priority write (#559 intact; see lib/supplement-demotion for
// the full contract and the medication/PRN/paused/cold-start exclusions).
//
// COACHING tier (#449) by hard product contract: it joins collectCoachingFindings,
// rides the shared suppression bus under DEMOTION_PREFIX, renders on the Supplements
// page and the calm dashboard rollup — and NEVER becomes a notification. Nagging
// someone about a supplement they have chosen not to take is precisely the failure
// mode this whole issue exists to remove, so it must not arrive as a push.
//
// Reads through the ONE shared item-level history gather (getIntakeHistory), the same
// evidence the digest deltas read, so the suggestion and the digest can never
// disagree about a day. No owned SQL.
export function buildDemotionSuggestionFindings(
  profileId: number,
  today: string
): Finding[] {
  const inputs: DemotionInput[] = getIntakeHistory(
    profileId,
    today,
    DEMOTION_WINDOW_DAYS
  ).map(({ item, strip, existedWholeWindow }) => ({
    itemId: item.id,
    name: item.name,
    kind: item.kind,
    obligation: item.obligation,
    asNeeded: Boolean(isPrn(item)),
    active: Boolean(item.active),
    strip,
    existedWholeWindow,
    // Episode anchor = the current year (#436): a lapse that recurs a year after
    // being dismissed re-surfaces instead of being silenced forever.
    periodAnchor: today.slice(0, 4),
  }));

  return detectDemotionCandidates(inputs).map((c) => ({
    domain: "demote-obligation",
    dedupeKey: c.key,
    supersedes: c.legacyKey,
    title: c.title,
    detail: c.detail,
    // Calm FYI — an observation about the user's own log, never an alarm.
    tone: "info" as const,
    evidence: `${c.takenDays} of ${c.occurrences} scheduled days over the last ${DEMOTION_WINDOW_DAYS} days`,
    actionHref: nutritionTabHref("supplements"),
    actionLabel: "Open supplements",
  }));
}

// ---- Domain: frequency-target right-sizing (coaching tier, issue #1670) ----

// Where each domain's suggestion is acted on — the surface that already owns that
// commitment, so "open it" lands where the user would have gone anyway.
const RIGHTSIZE_ACTION: Record<
  RightSizeDomain,
  { href: AppRoute; label: string }
> = {
  practice: { href: PRACTICES_HREF, label: "Open practices" },
  training: {
    href: "/training?tab=goals" as AppRoute,
    label: "Open weekly routine",
  },
  food: { href: nutritionTabHref("food"), label: "Open weekly habits" },
};

// The ONE gather → detect for a profile's right-size candidates: the completed-week
// history of every floor-carrying frequency target, run through the pure detector.
// Shared by the findings builder below AND by each domain's own suggestion card and
// the practice nudge's ride-along, so the card, the finding and the button can never
// disagree about whether a target is a candidate (one question, one computation).
export function collectRightSizeCandidates(
  profileId: number,
  today: string
): RightSizeCandidate[] {
  const inputs: RightSizeInput[] = getFrequencyTargetWeeklyHistory(
    profileId,
    RIGHTSIZE_WEEKS
  ).map(({ target, weeks, existedWholeWindow }) => ({
    targetId: target.id,
    scopeKind: target.scope_kind,
    // The label each domain's own surface shows: the practice's own name, the
    // food group's display name, the training scope's label.
    label:
      target.scope_kind === "practice"
        ? target.scope_value
        : frequencyScopeLabel(target.scope_kind, target.scope_value),
    floor: target.per_week,
    weeklyCounts: weeks.map((w) => w.count),
    existedWholeWindow,
    // Episode anchor = the current year (#436): a drift that recurs a year after
    // being dismissed re-surfaces instead of being silenced forever.
    periodAnchor: today.slice(0, 4),
  }));
  return detectRightSizeCandidates(inputs);
}

// A calm, dismissible SUGGESTION that a weekly floor the profile has been under for a
// month be lowered to what they actually do — or dropped, landing in the domain's own
// no-expectation state (logs-only practice, untracked routine, untracked food habit).
// The user's tap is the only write (#559/#1505 doctrine, generalized off intakes; see
// lib/target-rightsize for the full contract and the substance-cap/cold-start
// exclusions).
//
// COACHING tier (#449) by the same hard product contract the demotion suggestion
// carries: it joins collectCoachingFindings, rides the shared suppression bus under
// RIGHTSIZE_PREFIX, renders on each domain's own page and the calm dashboard rollup —
// and NEVER becomes a send of its own. Its only push presence is decorating the pace
// nudge that already fires for the target's own reasons (the ride-the-nag rule), which
// is exactly the nag this suggestion exists to end.
//
// Reads through the ONE shared weekly-history gather, the same per-scope counting the
// current-week progress rollup uses, so the suggestion and the progress card can never
// disagree about a week. No owned SQL.
export function buildTargetRightSizeFindings(
  profileId: number,
  today: string
): Finding[] {
  return collectRightSizeCandidates(profileId, today).map(
    rightSizeCandidateFinding
  );
}

// One candidate's Finding envelope. Exported so a domain's own suggestion card can
// run its candidates through the SAME suppression filter every other surface uses
// (activeFindings over these keys) without gathering the candidates a second time —
// the card and the coaching rollup then hide and re-appear together, by construction.
export function rightSizeCandidateFinding(c: RightSizeCandidate): Finding {
  return {
    domain: "right-size",
    dedupeKey: c.key,
    supersedes: c.legacyKey,
    title: c.title,
    detail: c.detail,
    // Calm FYI — an observation about the user's own log, never an alarm.
    tone: "info",
    evidence: c.evidence,
    actionHref: RIGHTSIZE_ACTION[c.domain].href,
    actionLabel: RIGHTSIZE_ACTION[c.domain].label,
  };
}

// ---- Domain: sun exposure (coaching tier only, issue #571) ----------------

// The vitamin-D outcome family: getBiomarkerSeries collapses D2/D3/total to one
// series (#482), so any member name resolves the whole family. This literal is a
// catalog member name (the passport reads the same one).
const VITAMIN_D_CANONICAL = "Vitamin D, 25-Hydroxy";

// A calm, OBSERVATIONAL coaching finding when a profile has logged little daylight-
// outdoor time over the recent window AND its last vitamin D was below optimal.
// Coaching tier only: it joins collectCoachingFindings, its dedupeKey rides the
// shared suppression bus (SUN_EXPOSURE_PREFIX is registered in RULE_FINDING_PREFIXES),
// and it NEVER notifies / never reaches the hero. Copy stays observational — sun
// exposure is dual-edged, so it surfaces the data and prescribes nothing. Needs a
// home location (else the daylight math is meaningless) → otherwise empty.
export function buildSunExposureFindings(
  profileId: number,
  today: string
): Finding[] {
  const home = getHomeLocation(profileId);
  if (!home) return [];

  // Latest vitamin-D reading (family-collapsed, oldest→newest → last is latest).
  const series = getBiomarkerSeries(profileId, VITAMIN_D_CANONICAL);
  const latest = series.at(-1);
  if (!latest || latest.value_num == null) return [];

  const cb = getCanonicalBiomarker(
    latest.canonical_name ?? VITAMIN_D_CANONICAL
  );
  const status = optimalStatus(
    latest.value_num,
    cb,
    getProfileSex(profileId),
    getProfileAge(profileId)
  );

  // Daylight-outdoor minutes over the window — the ONE computation (lib/queries/sun),
  // averaged to a per-week figure the copy formats.
  const windowDays = SUN_EXPOSURE_WINDOW_WEEKS * 7;
  const dates = lastNDates(today, windowDays);
  const totalMin = getDaylightOutdoorMinutesTotal(profileId, dates);
  const avgWeeklyDaylightMin = totalMin / SUN_EXPOSURE_WINDOW_WEEKS;

  const obs = decideSunExposure({
    hasHomeLocation: true,
    avgWeeklyDaylightMin,
    vitaminDStatus: status,
    vitaminDValue: latest.value_num,
    vitaminDUnit: latest.unit,
    vitaminDDate: latest.date,
  });
  if (!obs) return [];

  return [
    {
      domain: "sun-exposure",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm FYI — a neutral observation, never an alarm.
      tone: "info",
      // The biomarker browser lives on Results (#1164 merged the Trends duplicate in).
      actionHref: "/results/readings",
      actionLabel: "View biomarkers",
    },
  ];
}

// The item ids that are live demotion candidates right now (#1505 part 2) — the SAME
// detection the page card renders, exposed as a set so the reminder builder can add
// its ⤓ May button without re-deriving the threshold.
//
// Deliberately NOT bus-filtered: a page dismissal hides the CARD, not the button
// (owner-decided). The two surfaces answer different questions — "not on this screen"
// versus "is there still an escape hatch" — and conflating them would take the only
// affordance a tap-only user has away on a tap they made somewhere else entirely.
export function demotionCandidateItemIds(
  profileId: number,
  today: string
): Set<number> {
  const ids = new Set<number>();
  for (const f of buildDemotionSuggestionFindings(profileId, today)) {
    const id = demotionItemIdFromKey(f.dedupeKey);
    if (id != null) ids.add(id);
  }
  return ids;
}
