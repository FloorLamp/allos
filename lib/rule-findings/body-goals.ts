import {
  getWeightsOneSourcePerDay,
  getBodyMetricDailySeries,
  getOutcomeGoals,
} from "../queries";
import { isGoalLive } from "../outcome-goals";
import { shiftDateStr } from "../date";
import { fmtWeight, round } from "../units";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "../format-date";
import { describeEta } from "../trend-projection";
import type { Finding } from "../findings";
import { trainingTabHref } from "../hrefs";
import type { WeightUnit } from "../settings";
import {
  detectWeightAnomalies,
  weightAnomalySignalKey,
  type WeightAnomaly,
} from "../weight-anomaly";
import {
  biomarkerGoalCheckIn,
  biomarkerTargetOf,
  directionMet,
  labGoalHasCheckedIn,
} from "../biomarker-goal";
import { retestDaysForBiomarker } from "../biomarker-retest";
import { biomarkerPlots } from "../queries/biomarker-plot";
import { sameUnit } from "../unit-conversions";
import {
  assessGoalPace,
  detectFastWeightLoss,
  goalPaceSignalKey,
  weightLossRateSignalKey,
  weightLossRateLegacyKey,
  GOAL_PACE_WINDOW_DAYS,
} from "../goal-pacing";
import { COACHING_ENTITY_FINDING_LIMITS } from "./limits";

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
  return detectWeightAnomalies(weights, today)
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.bodyHygiene)
    .map((a) => weightAnomalyToFinding(a, wu, prefs));
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
    if (findings.length >= COACHING_ENTITY_FINDING_LIMITS.goalPacing) break;
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
      actionHref: trainingTabHref("plan", "goals"),
      actionLabel: "Review goal",
    });
  }

  // Off-pace BIOMARKER goals (#1853). Same builder, same `goal-pace:` namespace, same
  // dismiss action and therefore the same COACHING tier — a lab goal drifting is an
  // observation about a plan, not a safety signal, so it must not reach Upcoming, the
  // dashboard Now or a notification, and adding it here rather than to a new
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
  // The biomarker half is bounded on its OWN count (#4069). One counter shared with
  // the body-metric loop above meant three off-pace weight goals silenced EVERY lab
  // goal — and a weight goal cannot speak for a lab goal, so a full body half must not
  // decide that a drifting lipid panel goes unmentioned.
  let biomarkerFindings = 0;
  for (const { g, target, targetDate } of bmCandidates) {
    if (biomarkerFindings >= COACHING_ENTITY_FINDING_LIMITS.goalPacing) break;
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
      actionHref: trainingTabHref("plan", "goals"),
      actionLabel: "Review goal",
    });
    biomarkerFindings += 1;
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
