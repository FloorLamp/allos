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
  getGoals,
  getSupplements,
  getSupplementDoses,
  getSupplementLogsInRange,
  getActivityDates,
  getRecentDatedExercises,
  getFoodSuggestions,
  getFrequencyTargetProgress,
  getIntakeSafetyContext,
  getBiomarkerSeries,
  getCanonicalBiomarker,
  getDaylightOutdoorMinutesTotal,
  getProteinAdequacy,
  getFindingSuppressions,
} from "./queries";
import { activeFindings } from "./findings";
import { exerciseHistoryKey } from "./lifts";
import {
  getActiveSituations,
  getSituationEvents,
  getHomeLocation,
  getUserSex,
  getUserAge,
} from "./settings";
import { situationHistoryResolver } from "./trend-annotations";
import { optimalStatus } from "./reference-range";
import { decideSunExposure, SUN_EXPOSURE_WINDOW_WEEKS } from "./sun-exposure";
import { decidePeriodontalObservation } from "./oral-health-observation";
import { fitnessRetestDue, fitnessCheckSignalKey } from "./fitness-retest";
import { getLatestFitnessAssessmentDate } from "./fitness-assessment";
import { getFitnessRetestCadenceDays } from "./settings";
import {
  deriveRiskFactors,
  EMPTY_RISK_ATTRIBUTES,
} from "./risk-stratification";
import { isGoalLive, frequencyScopeLabel } from "./goals";
import { getRoutineCycleStatus } from "./routines";
import {
  foodHabitSignalKey,
  isFoodHabitBehind,
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "./food-habit";
import {
  proteinAdequacySignalKey,
  proteinAdequacyTitle,
  proteinAdequacyDetail,
  proteinAdequacyEvidence,
} from "./protein";
import { shiftDateStr, lastNDates } from "./date";
import { fmtWeight, round } from "./units";
import { formatLongDate } from "./format-date";
import { describeEta } from "./trend-projection";
import type { Finding } from "./findings";
import { biomarkerViewHref, nutritionTabHref, type AppRoute } from "./hrefs";
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
  assessGoalPace,
  detectFastWeightLoss,
  goalPaceSignalKey,
  weightLossRateSignalKey,
  weightLossRateLegacyKey,
  GOAL_PACE_WINDOW_DAYS,
} from "./goal-pacing";
import {
  detectAdherencePatterns,
  doseAdherenceSince,
  ADHERENCE_PATTERN_DAYS,
  type AdherencePattern,
  type DoseAdherenceInput,
} from "./adherence-patterns";
import {
  doseStrip,
  indexTakenByDose,
  stripWithoutTrailingPending,
} from "./supplement-adherence";
import { isDueOn, timeBucket } from "./supplement-schedule";

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
export function buildFitnessCheckFindings(
  profileId: number,
  today: string
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
      detail: `Your last fitness check was ${formatLongDate(d.lastDate)}${ago}. Re-run the battery to refresh your percentiles and see check-over-check change.`,
      tone: "info",
      evidence:
        "Informational — you set the retest cadence in Profile settings.",
      actionHref: "/training?tab=fitness" as AppRoute,
      actionLabel: "Start a check",
    },
  ];
}

export function collectCoachingFindings(
  profileId: number,
  today: string,
  wu: WeightUnit
): Finding[] {
  return [
    ...buildTrainingObservationFindings(profileId, today),
    ...buildMuscleVolumeFindings(profileId, today),
    ...buildBodyHygieneFindings(profileId, today, wu),
    ...buildGoalPacingFindings(profileId, today),
    ...buildAdherencePatternFindings(profileId, today),
    ...buildFoodSuggestionFindings(profileId),
    ...buildFoodHabitFindings(profileId),
    ...buildProteinAdequacyFindings(profileId),
    ...buildEndurancePlanFindings(profileId, today),
    ...buildSunExposureFindings(profileId, today),
    ...buildOralHealthFindings(profileId),
    ...buildFitnessCheckFindings(profileId, today),
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
        "Diabetes and periodontitis are bidirectionally linked (ADA / AAP). " +
        "Informational, not medical advice.",
      actionHref: "/encounters",
      actionLabel: "Dental care",
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
    evidence: `${s.evidence} Source: ${s.source}. Informational, not medical advice.`,
    actionHref: biomarkerViewHref(s.triggeredBy[0] ?? null),
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
  const e1rmSeries = getExerciseE1rmSeries(
    profileId,
    shiftDateStr(today, -PLATEAU_WINDOW_DAYS)
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
  dedupeKey: string;
  supersedes: string;
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
    shiftDateStr(today, -PLATEAU_WINDOW_DAYS)
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
      dedupeKey: o.key,
      supersedes: o.legacyKey,
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

// ---- Domain 5: body-metric data hygiene (Trends → Body) -------------------

function weightAnomalyToFinding(a: WeightAnomaly, wu: WeightUnit): Finding {
  const pct = Math.abs(round(a.changeFraction * 100, 1));
  const dir = a.changeFraction > 0 ? "up" : "down";
  const cur = fmtWeight(a.weightKg, wu);
  const prev = fmtWeight(a.prevWeightKg, wu);
  const detail = a.suspectedUnitError
    ? `On ${formatLongDate(a.date)} you logged ${cur}, ${pct}% ${dir} from ` +
      `${prev} on ${formatLongDate(a.prevDate)} — that looks like a kg/lb entry ` +
      `mix-up. Fixing or converting it keeps your weight trend honest.`
    : `On ${formatLongDate(a.date)} you logged ${cur}, ${pct}% ${dir} from ` +
      `${prev} on ${formatLongDate(a.prevDate)} — a jump that big over just a ` +
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
    actionHref: "/trends?tab=body",
    actionLabel: "Review in Body metrics",
  };
}

// Every body-metric hygiene finding for a profile: probable-error day-over-day weight
// jumps. `wu` renders the weights in the login's unit.
export function buildBodyHygieneFindings(
  profileId: number,
  today: string,
  wu: WeightUnit
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
    weightAnomalyToFinding(a, wu)
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

  // Weight readings in canonical kg, ascending, as projection input. The SAME
  // primary-source-collapsed daily series (one row/day, #14) the Trends → Body
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
  for (const g of getGoals(profileId)) {
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
      actionHref: "/trends?tab=body",
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
  const takenByDose = indexTakenByDose(
    getSupplementLogsInRange(profileId, ADHERENCE_PATTERN_DAYS)
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
    if (!supp || !supp.active || supp.as_needed) continue;
    const status = takenByDose.get(d.id);
    // Clamp the window to the dose's lifetime (#430): a day before the dose
    // existed with its current schedule is not a "miss" it defeated the
    // min-history gate with, nor a slot it can be re-accused of. `since` is the
    // later of the item's creation and this dose's last re-time.
    const since = doseAdherenceSince(
      supp.created_at,
      d.created_at,
      d.updated_at
    );
    const windowDates = since ? dates.filter((date) => date >= since) : dates;
    const strip = stripWithoutTrailingPending(
      doseStrip(
        windowDates,
        (date) =>
          isDueOn(supp, {
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
      // medication (#430.4) — fall back to the neutral reminder copy.
      suppressMoveSuggestion:
        timeBucket(d.time_of_day) === "Before sleep" ||
        supp.kind === "medication",
    });
  }

  return detectAdherencePatterns(inputs).map(adherencePatternToFinding);
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
    getUserSex(profileId),
    getUserAge(profileId)
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
      actionHref: "/trends?tab=biomarkers",
      actionLabel: "View biomarkers",
    },
  ];
}
