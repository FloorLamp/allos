// Goal pacing (issue #45, domain 6): two calm, observational checks over a
// profile's body-metric goals and weight trend, layered on the SAME robust
// projection the Trends → Body chart already draws (lib/trend-projection.projectGoal,
// Theil–Sen). Nothing here re-derives a slope — it reuses projectGoal so the finding
// and the chart caption can never disagree ("one question, one computation").
//
//   1. Off-pace goal: at the current fitted pace the target date is unreachable —
//      the trend is moving away, or it will arrive well past the deadline. Suggest
//      adjusting the date or the plan, never a specific prescription.
//   2. Safe-rate caution: weight is dropping faster than ~1%/week sustained — a
//      gentle nudge that faster isn't better (lean-mass/adherence risk).
//
// Pure and client-safe — no DB/network. The DB gather lives in lib/rule-findings.ts
// (getGoals + getWeights → these → Finding[]), surfaced on the Goals tab. Thresholds
// are named constants with rationale; boundaries unit-tested in
// lib/__tests__/goal-pacing.test.ts.

import { projectGoal, type ProjectionPoint } from "./trend-projection";
import { theilSenSlopePerDay, median, type DatedPoint } from "./robust-stats";

// ---- 1. Off-pace goal -----------------------------------------------------

// A projected arrival later than the deadline by MORE than this many days reads as
// "won't make it" rather than "roughly on time". Matches describeEta's default slack
// (±3 days = "on track"), so the finding fires exactly when the chart caption stops
// saying "on track".
export const PACE_SLACK_DAYS = 3;

// The trailing window (days) the goal-pacing finding fits its projection over (#433).
// The finding and the Trends → Body chart caption BOTH call projectGoal, but the
// finding used to feed it the raw all-source year of weights while the chart fed the
// primary-source-collapsed daily series windowed to the selected range — so the
// "can never disagree" comment was aspirational, not true (a 9-month-flat + 8-week-cut
// profile got "trending away" from the finding and "on track" from the chart). The
// builder now feeds the SAME deduped daily series windowed to this constant, which
// matches the chart's 90-day default range, so the two verdicts line up by
// construction. projectGoal's own docs favor a recent window over a stale year.
export const GOAL_PACE_WINDOW_DAYS = 90;

// The minimal goal slice the pacing check reads (Goal satisfies it). Only body-
// metric goals with a target value AND a target date can be paced.
export interface PaceableGoal {
  id: number;
  title: string;
  targetValue: number; // canonical unit (kg for weight)
  targetDate: string; // YYYY-MM-DD
  baselineValue: number | null;
}

export interface GoalPaceFinding {
  goalId: number;
  title: string;
  // "away": trend moving away from the target. "late": will arrive, but past the
  // deadline by more than the slack.
  status: "away" | "late";
  // Whole days late (status "late" only; null for "away").
  daysLate: number | null;
  // The projection's trust tier, so the surface can hedge a shaky ETA (#37).
  confidence: "low" | "ok";
}

// Assess one goal's pace from its windowed weight/metric trend. Returns a finding
// only when the goal is genuinely off pace: trending away, or projected to land more
// than PACE_SLACK_DAYS past its deadline. Reaching on time (or early) → null.
// `points` are the goal metric's dated readings in the SAME unit as target/baseline.
export function assessGoalPace(
  goal: PaceableGoal,
  points: readonly ProjectionPoint[]
): GoalPaceFinding | null {
  const projection = projectGoal(
    points,
    goal.targetValue,
    goal.targetDate,
    goal.baselineValue
  );
  if (!projection) return null; // insufficient / flat / already reached
  if (projection.status === "away") {
    return {
      goalId: goal.id,
      title: goal.title,
      status: "away",
      daysLate: null,
      confidence: projection.confidence,
    };
  }
  // "reaching": daysEarly is target_date − projectedDate; negative = late.
  const daysEarly = projection.daysEarly;
  if (daysEarly == null || daysEarly >= -PACE_SLACK_DAYS) return null;
  return {
    goalId: goal.id,
    title: goal.title,
    status: "late",
    daysLate: -daysEarly,
    confidence: projection.confidence,
  };
}

// The stable suppression/identity keys for the goal-pacing findings. One namespace
// (`goal-pace:`) so the page dismiss action guards the whole domain with one prefix.
export const GOAL_PACE_PREFIX = "goal-pace:";

// Per-goal off-pace finding, keyed by goal id (ids never recycle → a stale dismissal
// is a dead row, not wrong suppression). The key deliberately does NOT encode the
// target date — RE-TARGETING is a new pacing question, so updateGoal clears this
// dismissal on a target change (app/(app)/goals/actions.ts, #436/#203) rather than
// baking the date into the key.
export function goalPaceSignalKey(goalId: number): string {
  return `${GOAL_PACE_PREFIX}goal:${goalId}`;
}

// The legacy (pre-#436, episode-less) safe-rate caution key — one per profile. Kept
// only so a dismissal stored before #436 still suppresses the current caution via
// Finding.supersedes rather than orphaning.
export function weightLossRateLegacyKey(): string {
  return `${GOAL_PACE_PREFIX}weight-loss-rate`;
}

// The single safe-rate caution per profile, keyed by the loss window's start month
// (#436): a distinct fast-loss phase after a gap lands in a new month bucket and
// re-fires, rather than one dismissal silencing every future cut.
export function weightLossRateSignalKey(sinceMonth: string): string {
  return `${weightLossRateLegacyKey()}:${sinceMonth}`;
}

// ---- 2. Safe-rate weight-loss caution -------------------------------------

// Sustained loss faster than this fraction of body weight PER WEEK trips the gentle
// caution. ~1%/week is the widely-cited ceiling for preserving lean mass during a
// cut; below it, loss is mostly fat and adherence holds. Above it, faster isn't
// better.
export const SAFE_LOSS_FRACTION_PER_WEEK = 0.01;

// The trailing window (days) the loss rate is fit over — four weeks, so a single
// heavy week (a post-vacation drop, a stomach bug) can't trip it; the caution is
// about a SUSTAINED pace.
export const LOSS_WINDOW_DAYS = 28;

// Need at least this many readings in the window to trust a rate (a robust slope off
// two points is noise).
export const LOSS_MIN_POINTS = 4;

// …spanning at least this many days, so four weigh-ins in one week can't read as a
// four-week trend.
export const LOSS_MIN_SPAN_DAYS = 14;

export interface WeightLossCaution {
  // Estimated sustained loss as a POSITIVE fraction of body weight per week
  // (e.g. 0.015 = 1.5%/week).
  fractionPerWeek: number;
  // The trailing loss window's earliest reading, as YYYY-MM — the episode anchor
  // for the caution's dedupeKey (#436), so a fresh cut after a gap re-fires.
  sinceMonth: string;
}

// Whole days from an ISO date to `today`, or Infinity if unparseable.
function daysSince(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

// Detect a too-fast sustained weight loss over the trailing window, or null. Uses
// the robust Theil–Sen slope (kg/day) over the windowed weight series, normalized to
// a fraction of the window's median weight per week. Only a LOSS (negative slope)
// beyond the threshold trips it; weight gain / maintenance / slow loss → null.
// `points` are dated weight readings (kg), any order.
export function detectFastWeightLoss(
  points: readonly DatedPoint[],
  today: string
): WeightLossCaution | null {
  const windowed = points.filter((p) => {
    const ago = daysSince(p.date, today);
    return ago >= 0 && ago <= LOSS_WINDOW_DAYS;
  });
  if (windowed.length < LOSS_MIN_POINTS) return null;
  const dates = windowed.map((p) => p.date).sort();
  const span = daysSince(dates[0], dates[dates.length - 1]);
  if (span < LOSS_MIN_SPAN_DAYS) return null;
  const slope = theilSenSlopePerDay(windowed); // kg/day
  if (slope == null || slope >= 0) return null; // not losing
  const level = median(windowed.map((p) => p.value));
  if (!(level > 0)) return null;
  const fractionPerWeek = (Math.abs(slope) * 7) / level;
  if (fractionPerWeek <= SAFE_LOSS_FRACTION_PER_WEEK) return null;
  return { fractionPerWeek, sinceMonth: dates[0].slice(0, 7) };
}
