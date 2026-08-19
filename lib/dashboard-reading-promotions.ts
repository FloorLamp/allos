// Closed semantic reading promotions for the atomic dashboard (#3077 / #3137).
//
// This module compares domain verdicts that already exist. It does not judge a
// number, choose a threshold, read a clock, or perform I/O.

import { isNotableFlag } from "./reference-range";
import type { FrequencyPace } from "./frequency-targets";
import type { OutcomeGoalPace } from "./outcome-goals";
import { goalPaceTone } from "./outcome-goals";
import { isBiomarkerGoal } from "./biomarker-goal";
import { shiftDateStr } from "./date";
import type { GoalProgress } from "./goal-progress";
import type { OutcomeGoal } from "./types";
import type { DashboardReadingPromotion } from "./dashboard-relevance";

export const DASHBOARD_READING_PROMOTIONS = [
  "clinical-non-notable-to-notable",
  "weekly-target-transition",
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

export function sleepArrivedInWakeWindow(
  wakeDayAge: number | null,
  wakeMinutes: number,
  minutesOfDay: number,
  windowMinutes = 180
): boolean {
  if (wakeDayAge == null || wakeDayAge < 0) return false;
  const ageMinutes = wakeDayAge * 1440 + minutesOfDay - wakeMinutes;
  return ageMinutes >= 0 && ageMinutes <= windowMinutes;
}

export interface WeeklyTargetSemanticState {
  pace: FrequencyPace;
  met: boolean;
}

export function weeklyTargetStateChanged(
  current: WeeklyTargetSemanticState & { count: number },
  previous: WeeklyTargetSemanticState | null
): boolean {
  return (
    current.count > 0 &&
    previous != null &&
    (current.pace !== previous.pace || (!previous.met && current.met))
  );
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
  const currentPace = goalPaceTone(progress.pct, {
    createdAt: goal.created_at,
    targetDate: goal.target_date,
    today,
    ...(perResult ? { evidenceDate: progress.asOf ?? null } : {}),
  });
  const previousPace = goalPaceTone(progress.previous.pct, {
    createdAt: goal.created_at,
    targetDate: goal.target_date,
    today: perResult ? today : shiftDateStr(today, -1),
    ...(perResult ? { evidenceDate: progress.previous.asOf ?? null } : {}),
  });
  return outcomeGoalStateChanged(
    { pace: currentPace, complete: progress.done },
    { pace: previousPace, complete: progress.previous.done }
  );
}
