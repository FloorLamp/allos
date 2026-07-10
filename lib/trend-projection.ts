// Goal projection for the Trends hub. For a body-metric goal
// with a target value + target date (weight, body-fat), fit a robust trend over
// the windowed points and extrapolate at that pace from the latest reading to the
// target — answering "at current pace you reach X ~3 weeks early / late", or
// "trending away from goal".
//
// Robustness (#37): the slope is a Theil–Sen estimate (median of pairwise slopes),
// not ordinary least squares. OLS let a single spike bend the whole trend and hand
// back a confidently-wrong ETA; Theil–Sen tolerates a minority of outliers. A
// short or ragged series can still mislead, so the result also carries a
// `confidence` tier the UI can hedge with ("rough estimate").
//
// Pure math, unit-tested (lib/__tests__/trend-projection). The caller works in a
// single consistent unit (the chart's DISPLAY unit — e.g. kg for a weight goal,
// converted at the boundary); this module never converts units.

import { daysBetweenDateStr, shiftDateStr } from "./date";
import {
  theilSenSlopePerDay,
  pairwiseSlopesPerDay,
  median,
} from "./robust-stats";

// Fewer than this many points can't support a meaningful slope — return null
// rather than a jittery ETA off two readings. Kept at 3 (not raised): Theil–Sen
// already resists a lone outlier at low n, and the sub-5-point case is surfaced as
// confidence:"low" rather than suppressed, so the user still gets a hedged ETA.
export const MIN_PROJECTION_POINTS = 3;

// Below this many points a projection is always flagged low-confidence: even a
// robust slope off 3–4 readings is easily swayed, so the ETA is a rough guide.
const CONFIDENT_MIN_POINTS = 5;

// Beyond this horizon the pace is so slow the ETA is meaningless (a near-flat
// trend); treat it as flat and return null instead of a nonsense far-future date.
const MAX_HORIZON_DAYS = 3650; // ~10 years

// Values within this fraction of the span, or this absolute floor, count as "at"
// the target already (nothing to project).
const REACHED_TOL = 1e-9;

export interface ProjectionPoint {
  date: string; // YYYY-MM-DD
  value: number; // in the chart's display unit
}

export interface GoalProjection {
  // "reaching": the fitted pace moves toward the target and gets there.
  // "away": the trend is moving away from the target (never reaches at this pace).
  status: "reaching" | "away";
  // Modeled change per day (display unit / day); sign shows the trend direction.
  slopePerDay: number;
  // The date the target is reached at current pace (status "reaching" only).
  projectedDate: string | null;
  // projectedDate vs the goal's target_date, in whole days: POSITIVE = reaching
  // before the deadline (early), NEGATIVE = after (late). null when the goal has
  // no target_date, or status is "away".
  daysEarly: number | null;
  // How much to trust the slope/ETA (#37). "low" when there are few points
  // (< CONFIDENT_MIN_POINTS) OR the pairwise slopes scatter widely (their MAD
  // exceeds the |median slope|, i.e. the direction itself is uncertain); "ok"
  // otherwise. The UI hedges a low-confidence ETA as a "rough estimate".
  confidence: "low" | "ok";
}

// Whether the pairwise slopes scatter too widely to trust the direction: their
// median absolute deviation exceeds the magnitude of the median slope itself. When
// the spread of "which way is it going" estimates is as large as the estimate, the
// trend is effectively undetermined. (|median slope| of 0 is treated as wide unless
// the spread is also 0.)
function slopesAreScattered(slopes: number[]): boolean {
  if (slopes.length < 2) return false;
  const mid = median(slopes);
  const mad = median(slopes.map((s) => Math.abs(s - mid)));
  return mad > Math.abs(mid);
}

// Project a body-metric goal from its windowed trend.
//   - null: insufficient (<MIN points), no time spread, flat/too-slow to reach in
//     a sane horizon, or already reached the target (at it, or overshot past it in
//     the goal's intended direction — nothing to project).
//   - { status: "away", … }: trend moving away from a not-yet-reached target.
//   - { status: "reaching", projectedDate, daysEarly, … }: reaches the target;
//     daysEarly compares to target_date when one is given.
//
// `baseline` is the goal's starting value (goal.baseline_value, in the SAME unit
// as the points/target). It fixes the goal's intended DIRECTION (sign(target −
// baseline)) so an overshoot reads as "reached" rather than "away". When it's null
// or equal to the target (a maintain goal), the direction falls back to the current
// gap — the value simply still needs to move toward the target from where it is.
export function projectGoal(
  points: readonly ProjectionPoint[],
  target: number,
  targetDate: string | null,
  baseline: number | null = null
): GoalProjection | null {
  const pts = points.filter((p) => Number.isFinite(p.value));
  if (pts.length < MIN_PROJECTION_POINTS) return null;

  const slope = theilSenSlopePerDay(pts);
  if (slope == null || slope === 0) return null;

  // Trust tier: shaky on few points or a widely-scattered set of pairwise slopes.
  const confidence: "low" | "ok" =
    pts.length < CONFIDENT_MIN_POINTS ||
    slopesAreScattered(pairwiseSlopesPerDay(pts))
      ? "low"
      : "ok";

  const last = pts[pts.length - 1];
  const gap = target - last.value; // signed distance still to cover
  const tol = Math.max(REACHED_TOL, Math.abs(target) * REACHED_TOL);
  if (Math.abs(gap) <= tol) return null; // sitting on the target — nothing to project

  // The direction the value must travel to approach the target: from the baseline
  // when known, else inferred from the current gap.
  const desiredDir =
    baseline != null && baseline !== target
      ? Math.sign(target - baseline)
      : Math.sign(gap);

  // Overshot past the target in the intended direction → the goal was reached.
  if (Math.sign(gap) === -desiredDir) return null;

  // Not moving toward the target (wrong-way or flat trend) → trending away.
  if (Math.sign(slope) !== desiredDir) {
    return {
      status: "away",
      slopePerDay: slope,
      projectedDate: null,
      daysEarly: null,
      confidence,
    };
  }

  const daysToTarget = gap / slope; // > 0: gap and slope share the desired sign
  if (daysToTarget > MAX_HORIZON_DAYS) return null; // too slow → flat, no ETA

  const projectedDate = shiftDateStr(last.date, Math.round(daysToTarget));
  const daysEarly =
    targetDate != null ? daysBetweenDateStr(projectedDate, targetDate) : null;

  return {
    status: "reaching",
    slopePerDay: slope,
    projectedDate,
    daysEarly,
    confidence,
  };
}

// A short, unit-free phrase for how the projection lands against the deadline.
// `daysEarly` is target_date − projectedDate (positive = early). Within ±`slack`
// days reads as "on track". Weeks are rounded; < 14 days shown in days.
export function describeEta(daysEarly: number, slack = 3): string {
  if (Math.abs(daysEarly) <= slack) return "on track";
  const early = daysEarly > 0;
  const days = Math.abs(daysEarly);
  const amount =
    days < 14
      ? `${days} day${days === 1 ? "" : "s"}`
      : `${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? "" : "s"}`;
  return `~${amount} ${early ? "early" : "late"}`;
}
