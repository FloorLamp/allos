// Closed semantic reading promotions for the atomic dashboard (#3077 / #3137).
//
// This module compares domain verdicts that already exist. It does not judge a
// number, choose a threshold, read a clock, or perform I/O.

import { isNotableFlag } from "./reference-range";
import type { OutcomeGoalPace } from "./outcome-goals";
import { goalPaceTone } from "./outcome-goals";
import { isBiomarkerGoal } from "./biomarker-goal";
import { shiftDateStr } from "./date";
import type { GoalProgress } from "./goal-progress";
import type { OutcomeGoal } from "./types";
import type { DashboardReadingPromotion } from "./dashboard-relevance";

export const DASHBOARD_READING_PROMOTIONS = [
  "clinical-non-notable-to-notable",
  "outcome-goal-transition",
  "training-best",
  "sleep-arrived",
  "nap-ended",
] as const satisfies readonly DashboardReadingPromotion[];

export function clinicalResultBecameNotable(
  currentFlag: string | null,
  previousFlag: string | null | undefined
): boolean {
  return (
    previousFlag !== undefined &&
    !isNotableFlag(previousFlag) &&
    isNotableFlag(currentFlag)
  );
}

// `contradicted` is the #4299 verdict, already reached by the clock-skew detector: this
// night's synced session disagrees with the heart rate recorded across it. A promotion
// lifts a reading into the Standing attention tier, and a tier built on data the body's
// own record contradicts is noise wearing a safety costume — so the arrival is withheld
// and the family sits in its quiet band. It is a VERDICT compared here, not judged here:
// nothing in this module reads a bpm, a bedtime history or a timezone switch.
export function sleepArrivedInWakeWindow(
  freshness: "last-night" | "recent" | "stale",
  wakeDayAge: number | null,
  wakeMinutes: number,
  minutesOfDay: number,
  contradicted = false,
  windowMinutes = 180
): boolean {
  if (
    contradicted ||
    freshness !== "last-night" ||
    wakeDayAge == null ||
    wakeDayAge < 0
  )
    return false;
  const ageMinutes = wakeDayAge * 1440 + minutesOfDay - wakeMinutes;
  return ageMinutes >= 0 && ageMinutes <= windowMinutes;
}

export interface OutcomeGoalSemanticState {
  pace: OutcomeGoalPace;
  complete: boolean;
}

export function outcomeGoalStateChanged(
  current: OutcomeGoalSemanticState,
  previous: OutcomeGoalSemanticState | null
): boolean {
  return (
    previous != null &&
    (current.pace !== previous.pace || (!previous.complete && current.complete))
  );
}

export function outcomeGoalProgressChanged(
  goal: OutcomeGoal,
  progress: GoalProgress | undefined,
  today: string
): boolean {
  if (!progress?.previous) return false;
  if (goal.target_date && goal.target_date < today) return false;
  const perResult = isBiomarkerGoal(goal);
  const periodStartDate = progress.periodStartDate ?? goal.created_at;
  const currentPace = goalPaceTone(progress.pct, {
    createdAt: periodStartDate,
    targetDate: goal.target_date,
    today,
    ...(perResult ? { evidenceDate: progress.asOf ?? null } : {}),
  });
  const previousPace = goalPaceTone(progress.previous.pct, {
    createdAt: periodStartDate,
    targetDate: goal.target_date,
    today: perResult
      ? today
      : (progress.previous.comparisonDate ?? shiftDateStr(today, -1)),
    ...(perResult ? { evidenceDate: progress.previous.asOf ?? null } : {}),
  });
  return outcomeGoalStateChanged(
    { pace: currentPace, complete: progress.done },
    { pace: previousPace, complete: progress.previous.done }
  );
}
