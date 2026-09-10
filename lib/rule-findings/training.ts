import {
  getStrengthByExercise,
  getExerciseSetCountsSince,
  getExerciseE1rmSeries,
  getRecentDatedExercises,
  getFindingSuppressions,
} from "../queries";
import { activeFindings } from "../findings";
import { exerciseHistoryKey } from "../lifts";
import { getProfileAge } from "../settings";
import { isAdultForClinical } from "../life-stage";
import { fitnessRetestDue, fitnessCheckSignalKey } from "../fitness-retest";
import { getLatestFitnessAssessmentDate } from "../fitness-assessment";
import { getMobilitySuggestions } from "../queries/mobility";
import { getFitnessRetestCadenceDays } from "../settings";
import { getRoutineCycleStatus } from "../routines";
import { shiftDateStr } from "../date";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "../format-date";
import { FINDING_DASHBOARD_RELEVANCE, type Finding } from "../findings";
import { trainingTabHref, strengthAnalyzeHref, type AppRoute } from "../hrefs";
import { getWeekStart } from "../settings";
import {
  detectPushPullImbalance,
  detectStaleExercises,
  detectPlateaus,
  staleExerciseGroupEpisodeStart,
  staleExerciseGroupFamily,
  staleExerciseGroupSignalKey,
  BALANCE_WINDOW_DAYS,
  PLATEAU_WINDOW_DAYS,
  type StaleExerciseObservation,
  type TrainingObservation,
} from "../training-observations";
import { plateauInlineHint } from "../plateau-advice";
import { coverageFromSets } from "../muscle-coverage";
import {
  detectVolumeShortfalls,
  countDistinctWeeks,
  VOLUME_BAND_WINDOW_DAYS,
  type VolumeBandObservation,
} from "../muscle-volume-bands";
import { getInjuryConstraints } from "../injuries";
import { excludedRegions } from "../injury-model";
import {
  enduranceLongSessionKey,
  enduranceLongSessionTitle,
  enduranceLongSessionDetail,
} from "../endurance-plan";
import { getEndurancePlanCards, getIllnessCoachingContext } from "../queries";
import { COACHING_ENTITY_FINDING_LIMITS } from "./limits";

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
  // The check's call to action and copy are explicitly about adult-population
  // percentiles. Historical rows stay preserved, but a minor or unknown-age
  // profile must not get a dead-end reminder for an adult-only route.
  if (!isAdultForClinical(getProfileAge(profileId))) return [];
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
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "Informational — you set the retest cadence in Profile settings.",
      actionHref: "/training/fitness-check" as AppRoute,
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
    actionHref: trainingTabHref("overview"),
    actionLabel: "Track it",
  }));
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
  return out.slice(0, COACHING_ENTITY_FINDING_LIMITS.endurancePlan);
}

// ---- Domain 4: training balance + plateau (Training → Overview) -----------

function trainingObservationToFinding(o: TrainingObservation): Finding {
  return {
    domain: `training-${o.kind}`,
    dedupeKey: o.key,
    // Honor a pre-#436 dismissal under the episode-less key (#436 dual-read).
    supersedes: o.legacyKey,
    title: o.title,
    detail: o.detail,
    tone: "caution",
    actionHref: o.exercise
      ? strengthAnalyzeHref(o.exercise)
      : trainingTabHref("overview"),
    actionLabel: o.exercise ? "View exercise" : "View training",
  };
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function staleExerciseGroupFinding(
  observations: readonly StaleExerciseObservation[],
  episodeStart: string
): Finding | null {
  if (observations.length === 0) return null;
  const names = observations
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.staleExerciseNames)
    .flatMap((observation) =>
      observation.exercise ? [observation.exercise] : []
    );
  const title =
    observations.length === 1
      ? `${names[0]} has lapsed`
      : observations.length <= names.length
        ? `${observations.length} lifts have lapsed — ${listNames(names)}`
        : `Several lifts have lapsed — ${listNames(names)}`;
  const detail =
    observations.length === 1
      ? `You trained ${names[0]} regularly but not in the last three to eight weeks. ` +
        "If it is still part of your plan, work it back into the rotation."
      : "These were trained regularly but not in the last three to eight weeks. " +
        "If they are still part of your plan, work them back into the rotation.";
  return {
    domain: "training-stale",
    dedupeKey: staleExerciseGroupSignalKey(episodeStart),
    episodeFamily: staleExerciseGroupFamily(),
    title,
    detail,
    tone: "info",
    dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
    actionHref: trainingTabHref("overview"),
    actionLabel: "View training",
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

  const findings: Finding[] = [];
  const imbalance = detectPushPullImbalance(setCounts);
  if (imbalance) findings.push(trainingObservationToFinding(imbalance));
  const staleObservations = detectStaleExercises(
    stats.map((s) => ({
      exercise: s.exercise,
      sessions: s.sessions,
      lastDate: s.lastDate,
    })),
    today
  );
  const staleEpisodeStart = staleExerciseGroupEpisodeStart(
    stats.flatMap((stat) =>
      stat.volume.map(({ date }) => ({ exercise: stat.exercise, date }))
    ),
    today
  );
  if (staleEpisodeStart) {
    const stale = staleExerciseGroupFinding(
      staleObservations,
      staleEpisodeStart
    );
    if (stale) findings.push(stale);
  }
  // Cross-reference the routine's mesocycle (#741): when its deload week is ≤2 weeks
  // away, the plateau finding points at that built-in light week instead of advising
  // an ad-hoc deload. Same ONE gather every deload surface reads.
  const cycle = getRoutineCycleStatus(profileId, today);
  const upcomingDeload =
    cycle && cycle.weeksUntilDeload <= 2
      ? { weeksUntilDeload: cycle.weeksUntilDeload }
      : null;
  findings.push(
    ...detectPlateaus(e1rmSeries, today, upcomingDeload)
      .slice(0, COACHING_ENTITY_FINDING_LIMITS.trainingPlateau)
      .map(trainingObservationToFinding)
  );

  return findings;
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
    // Calm, observational FYI — never a push, never dashboard Now (#449).
    tone: "info",
    actionHref: trainingTabHref("overview"),
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
  const historyWeeks = countDistinctWeeks(
    datedExercises.map((d) => d.date),
    getWeekStart(profileId)
  );
  return detectVolumeShortfalls(inputs, {
    historyWeeks,
    deloadActive: isRoutineDeloadWeek(profileId, today),
    monthAnchor: today.slice(0, 7), // YYYY-MM episode anchor (#436)
    // Active-injury region exclusion (#838): a shortfall for an off-limits region is noise
    // while it's out. The SAME injury constraints the recommendation model excludes on.
    excludedRegions: excludedRegions(getInjuryConstraints(profileId)),
  }).map(volumeObservationToFinding);
}
