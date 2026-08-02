// Biomarker goals (#1853): "LDL under 100 by June", "A1c below 7", "BP systolic
// under 120". The PURE half — no DB, no network, client-safe.
//
// This module owns only what is genuinely new: the direction verdict, the unit
// guard, and the CHECK-IN RHYTHM that makes a lab goal pace per RESULT instead of
// per day. Everything else is deliberately borrowed:
//
//   • progress            → baselineTargetProgress (lib/goal-progress), the SAME
//                           baseline→target computation body-metric goals use.
//   • the off-pace verdict → assessGoalPace (lib/goal-pacing) over projectGoal, the
//                           SAME robust projection the Trends charts caption.
//   • the series           → the analyte's #482 FAMILY series in its charted unit,
//                           gathered by lib/queries/biomarker-plot — the SAME plot
//                           the biomarker detail page draws.
//   • the cadence          → retestDaysForBiomarker (lib/biomarker-retest), the SAME
//                           curated interval the Upcoming retest signal runs on.
//
// WHY A LAB GOAL DOES NOT PACE DAILY
//
// A body-weight goal legitimately re-paces every morning, because a new reading
// arrives every morning: on day 40 of a 100-day goal the clock genuinely owes you
// 40% of the distance, and the scale can genuinely report whether you are there. A
// lab value cannot. It changes when a tube is drawn. Between draws NOTHING about the
// goal has changed, so a verdict that moves anyway is measuring the calendar, not the
// person — it would quietly slide a goal from "on pace" to "behind" on a Tuesday when
// no lab was drawn, and the only honest thing the user could do about it is nothing.
//
// So the owed line is frozen at the last piece of EVIDENCE (see `evidenceDate` on
// goalPaceTone) and the natural check-in rhythm is the analyte's retest cadence: the
// goal is re-assessed when a result lands, and what it says between results is when
// the next one is due.

import { shiftDateStr, daysBetweenDateStr } from "./date";
import { baselineTargetProgress, type GoalProgress } from "./goal-progress";
import { sameUnit } from "./unit-conversions";
import type { Goal, GoalDirection } from "./types";

// A goal is biomarker-linked when it names an analyte AND declares a direction.
// Both are required: an analyte with no direction cannot say what "met" means, and a
// direction with no analyte names nothing. Mirrors the exercise-goal rule (BOTH
// `exercise` and `metric`), so a half-written row falls through to the freeform
// basis rather than rendering a bogus 0%.
export function isBiomarkerGoal(goal: {
  biomarker_name: string | null;
  target_direction: GoalDirection | null;
}): boolean {
  return !!goal.biomarker_name?.trim() && goal.target_direction != null;
}

// The minimal goal slice this module reads (Goal satisfies it).
export interface BiomarkerGoalTarget {
  // The analyte the goal is anchored on — a DISPLAY name. Readings reach the goal
  // through biomarkerFamily at the gather boundary, never by comparing this string.
  name: string;
  value: number;
  // The unit `value` is expressed in — the analyte's charted unit at capture time.
  unit: string | null;
  direction: GoalDirection;
  baselineValue: number | null;
}

// Why a biomarker goal has no progress to show, or null when it has.
//   "no-readings"    — the family has no numeric reading to measure against yet.
//   "unit-mismatch"  — the series is now charted in a unit the stored target was not
//                      captured in (a lab switched units on an analyte with no
//                      canonical unit). mg/dL and mmol/L differ by ~39× for a lipid,
//                      so comparing them anyway would render a confident lie; the
//                      surface says so and offers a re-target instead.
export type BiomarkerGoalUnavailable = "no-readings" | "unit-mismatch";

export interface BiomarkerGoalProgress extends GoalProgress {
  // The date of the reading `current` came from — the goal's EVIDENCE date, which is
  // what the pace verdict advances on.
  asOf: string | null;
  // The unit both `current` and `target` are in (the series' charted unit).
  unit: string | null;
  unavailable: BiomarkerGoalUnavailable | null;
}

// Whether a value is on the wanted side of the target. Inclusive on both sides: a
// user who wrote "under 100" and landed exactly on 100 has hit their number, and a
// float-exact equality test on a lab value would be a coin flip anyway.
export function directionMet(
  direction: GoalDirection,
  current: number,
  target: number
): boolean {
  return direction === "below" ? current <= target : current >= target;
}

// Progress for a biomarker goal over the analyte's charted series.
//
// `series` is the analyte's FAMILY series in `seriesUnit`, oldest→newest — exactly
// what lib/queries/biomarker-plot hands the biomarker detail page. `current` is the
// LATEST reading, not a windowed best: a lab value is a state, not a personal
// record, so the most recent draw is the answer and an old good result is history.
//
// `done` comes from the declared DIRECTION rather than from pct, so "under 100" with
// no baseline (a goal set before the first draw) still completes when a result comes
// in under 100. pct is the shared baseline→target computation, which needs a
// baseline and is only a bar length.
export function computeBiomarkerGoalProgress(
  target: BiomarkerGoalTarget,
  series: readonly { date: string; value: number }[],
  seriesUnit: string | null
): BiomarkerGoalProgress {
  const base = {
    target: target.value,
    unit: target.unit ?? seriesUnit,
  };
  if (!sameUnit(target.unit, seriesUnit)) {
    return {
      current: 0,
      target: target.value,
      pct: 0,
      done: false,
      asOf: null,
      unit: target.unit,
      unavailable: "unit-mismatch",
    };
  }
  const latest = series.length ? series[series.length - 1] : null;
  if (!latest) {
    return {
      ...base,
      current: 0,
      pct: 0,
      done: false,
      asOf: null,
      unavailable: "no-readings",
    };
  }
  const progress = baselineTargetProgress(
    latest.value,
    target.value,
    target.baselineValue
  );
  return {
    ...progress,
    ...base,
    done: directionMet(target.direction, latest.value, target.value),
    asOf: latest.date,
    unavailable: null,
  };
}

// ---- The check-in rhythm ---------------------------------------------------

// The cadence a lab goal is re-assessed on when the analyte carries no curated
// retest interval. Matches lib/reference-range's DEFAULT_RETEST_DAYS — the same flat
// fallback the retest signal uses — so an uncurated analyte's goal and its retest
// nudge agree about when "next" is.
export const DEFAULT_GOAL_CHECK_IN_DAYS = 365;

export interface BiomarkerGoalCheckIn {
  // The analyte's check-in cadence in days.
  cadenceDays: number;
  // When the next result is expected, or null when none has ever landed (there is
  // nothing to count from, and inventing "today + cadence" would put a goal set
  // years ago permanently one cadence in the future).
  dueDate: string | null;
  // Whether that expected result is now due (or overdue).
  due: boolean;
  // Whole days since the last result, or null when there is none.
  daysSinceResult: number | null;
}

// When this goal's next check-in falls, from the last result's date and the analyte's
// cadence. Pure calendar math over inputs the caller resolved through the shared
// cadence lookup — this module never picks a cadence itself.
export function biomarkerGoalCheckIn(
  lastResultDate: string | null,
  cadenceDays: number,
  today: string
): BiomarkerGoalCheckIn {
  const cadence =
    Number.isFinite(cadenceDays) && cadenceDays > 0
      ? Math.round(cadenceDays)
      : DEFAULT_GOAL_CHECK_IN_DAYS;
  if (!lastResultDate) {
    return {
      cadenceDays: cadence,
      dueDate: null,
      due: true,
      daysSinceResult: null,
    };
  }
  const dueDate = shiftDateStr(lastResultDate, cadence);
  const elapsed = daysBetweenDateStr(lastResultDate, today);
  return {
    cadenceDays: cadence,
    dueDate,
    due: dueDate <= today,
    daysSinceResult: elapsed,
  };
}

// Whether a lab goal may be given an off-pace VERDICT at all right now.
//
// The gate is EVIDENCE, not the clock: a goal is assessed when a result has landed
// since it was created, and it keeps whatever that result said until the next one
// arrives. A goal with no post-creation result has nothing to be off pace about — it
// has not been measured once since the user set it, so the only true statement is
// "no result yet", never "behind".
//
// This is the whole difference from the daily model. A body-weight goal is assessed
// every day because it is MEASURED every day; a lab goal that has not been drawn
// since January cannot become newly off pace in March.
export function labGoalHasCheckedIn(
  createdAt: string,
  lastResultDate: string | null
): boolean {
  if (!lastResultDate) return false;
  // created_at is a datetime stamp; its Timeline day is its first 10 chars.
  return lastResultDate >= createdAt.slice(0, 10);
}

// The target phrase — "LDL Cholesterol under 100 mg/dL". One formatter, so the goal
// card, the biomarker detail page and the off-pace finding all say it the same way.
export function biomarkerGoalTargetText(goal: {
  biomarker_name: string | null;
  target_value: number | null;
  unit: string | null;
  target_direction: GoalDirection | null;
}): string | null {
  if (!isBiomarkerGoal(goal) || goal.target_value == null) return null;
  const word = goal.target_direction === "below" ? "under" : "over";
  const unit = goal.unit?.trim();
  return `${goal.biomarker_name!.trim()} ${word} ${goal.target_value}${
    unit ? ` ${unit}` : ""
  }`;
}

// The BiomarkerGoalTarget a stored goal row describes, or null when the row is not a
// well-formed biomarker goal. One place the column tuple is read, so no surface
// re-derives which columns mean what.
export function biomarkerTargetOf(goal: Goal): BiomarkerGoalTarget | null {
  if (!isBiomarkerGoal(goal) || goal.target_value == null) return null;
  return {
    name: goal.biomarker_name!.trim(),
    value: goal.target_value,
    unit: goal.unit,
    direction: goal.target_direction!,
    baselineValue: goal.baseline_value,
  };
}
