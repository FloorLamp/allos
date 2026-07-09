import { db, today } from "../db";
import { getMetricDailyTotals } from "./metrics";
import {
  getActivityDates,
  getCardioByActivity,
  getFrequencyTargetProgress,
  getStrengthByExercise,
} from "./training";
import type { CoachingInput, RestingHrSignal, SleepSignal } from "../coaching";
import type { DistanceUnit, WeightUnit } from "../settings";

// How many recent nights / days to average for a recovery baseline. Long enough
// to be a stable personal norm, short enough to reflect the current block.
const RECOVERY_BASELINE_DAYS = 30;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// Population standard deviation of the baseline window, used as the personal
// variability the coaching engine widens its rest-nudge thresholds by (#44 item
// 3a). Needs at least two points to mean anything; returns undefined otherwise so
// the caller omits the field and the engine falls back to its fixed threshold.
function spread(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

// Last night's total sleep (minutes) and the recent baseline, or null when no
// sleep has been synced. Reads the per-night `sleep_min` totals from
// metric_samples (profile-scoped in getMetricDailyTotals). Baseline is the mean
// of the prior nights in the window (falls back to all nights when only one).
export function getSleepSignal(profileId: number): SleepSignal | null {
  const nights = getMetricDailyTotals(
    profileId,
    "sleep_min",
    RECOVERY_BASELINE_DAYS
  ); // oldest → newest
  if (nights.length === 0) return null;
  const lastNightMin = nights[nights.length - 1].value;
  const prior = nights.slice(0, -1);
  const baseNights = prior.length ? prior : nights;
  const baselineMin = mean(baseNights.map((n) => n.value));
  const baselineSpreadMin = spread(prior.map((n) => n.value));
  return {
    lastNightMin,
    baselineMin,
    ...(baselineSpreadMin != null ? { baselineSpreadMin } : {}),
  };
}

// The most recent resting HR (bpm) and the recent baseline, or null when none is
// recorded. Resting HR lives one-per-day in body_metrics (#120), so this reads
// that column directly (profile-scoped). Baseline is the mean of the prior days
// in the window (falls back to all when only one reading exists).
export function getRestingHrSignal(profileId: number): RestingHrSignal | null {
  const rows = db
    .prepare(
      `SELECT resting_hr AS v FROM body_metrics
        WHERE profile_id = ? AND resting_hr IS NOT NULL
        ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(profileId, RECOVERY_BASELINE_DAYS) as { v: number }[];
  if (rows.length === 0) return null;
  const recent = rows[0].v;
  const prior = rows.slice(1);
  const baseline = mean((prior.length ? prior : rows).map((r) => r.v));
  const baselineSpreadBpm = spread(prior.map((r) => r.v));
  return {
    recent,
    baseline,
    ...(baselineSpreadBpm != null ? { baselineSpreadBpm } : {}),
  };
}

// Assemble the full coaching input from profile-scoped reads. Used by the
// dashboard Coaching widget's loader; the Training overview builds the same
// bundle inline from data it has already fetched (reusing the two signal
// readers above). `distanceUnit` is only needed to satisfy getCardioByActivity's
// signature — the engine reads activity name + last date, not formatted text.
export function gatherCoachingInput(
  profileId: number,
  weightUnit: WeightUnit,
  distanceUnit: DistanceUnit
): CoachingInput {
  return {
    today: today(profileId),
    routine: getFrequencyTargetProgress(profileId),
    strength: getStrengthByExercise(profileId),
    cardio: getCardioByActivity(profileId, distanceUnit),
    trainingDates: getActivityDates(profileId),
    sleep: getSleepSignal(profileId),
    restingHr: getRestingHrSignal(profileId),
    weightUnit,
  };
}
