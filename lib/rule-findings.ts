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
  getBodyMetricDailySeries,
  getGoals,
  getSupplements,
  getSupplementDoses,
  getSupplementLogsInRange,
  getActivityDates,
} from "./queries";
import { getActiveSituations } from "./settings";
import { shiftDateStr, lastNDates } from "./date";
import { fmtWeight, round } from "./units";
import { formatLongDate } from "./format-date";
import { describeEta } from "./trend-projection";
import type { Finding } from "./findings";
import type { WeightUnit } from "./settings";
import {
  detectPushPullImbalance,
  detectStaleExercises,
  detectPlateaus,
  BALANCE_WINDOW_DAYS,
  PLATEAU_WINDOW_DAYS,
  type TrainingObservation,
} from "./training-observations";
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
export function collectCoachingFindings(
  profileId: number,
  today: string,
  wu: WeightUnit
): Finding[] {
  return [
    ...buildTrainingObservationFindings(profileId, today),
    ...buildBodyHygieneFindings(profileId, today, wu),
    ...buildGoalPacingFindings(profileId, today),
    ...buildAdherencePatternFindings(profileId, today),
  ];
}

// ---- Domain 4: training balance + plateau (Training → Overview) -----------

// The deep link a stale/plateau exercise finding points at — the Analyze tab focused
// on that exercise (same link coaching's strength recs use).
function exerciseHref(exercise: string): string {
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
  observations.push(...detectPlateaus(e1rmSeries, today));

  return observations.map(trainingObservationToFinding);
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
  const weights = getWeights(profileId).map((w) => ({
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
      g.archived !== 0 ||
      g.status !== "active" ||
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
    actionHref: "/medicine",
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
  const activeSituations = new Set(getActiveSituations(profileId));

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
            activeSituations,
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
