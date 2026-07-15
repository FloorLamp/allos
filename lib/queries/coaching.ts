import { db, today } from "../db";
import { getMetricDailyTotals } from "./metrics";
import {
  getActivityDates,
  getCardioByActivity,
  getFrequencyTargetProgress,
  getRecentDatedExercises,
  getStrengthByExercise,
} from "./training";
import { getIntensitySignal } from "./zones";
import {
  nextRestEpisode,
  recommendCoaching,
  type CoachingInput,
  type Recommendation,
  type RestEpisode,
  type RestingHrSignal,
  type SleepSignal,
} from "../coaching";
import {
  deleteProfileSetting,
  getProfileSetting,
  setProfileSetting,
  type DistanceUnit,
  type WeightUnit,
} from "../settings";
import { availableEquipmentKinds } from "../equipment";
import { getActiveRoutine, getRoutineCycleStatus } from "../routines";

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
// recorded. Resting HR lives one-per-day in body_metrics, so this reads
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
  const todayStr = today(profileId);
  return {
    today: todayStr,
    routine: getFrequencyTargetProgress(profileId),
    strength: getStrengthByExercise(profileId),
    cardio: getCardioByActivity(profileId, distanceUnit),
    trainingDates: getActivityDates(profileId),
    datedExercises: getRecentDatedExercises(profileId),
    availableEquipment: availableEquipmentKinds(profileId),
    activeRoutine: getActiveRoutine(profileId),
    deloadWeek:
      getRoutineCycleStatus(profileId, todayStr)?.isDeloadWeek ?? false,
    sleep: getSleepSignal(profileId),
    restingHr: getRestingHrSignal(profileId),
    restEpisode: getRestEpisode(profileId),
    intensity: getIntensitySignal(profileId),
    weightUnit,
  };
}

// ---- Rest-episode continuity persistence (#44 item 3b) ----
//
// The rest nudge's cross-day memory lives in one per-profile profile_settings row
// (JSON), mirroring the refill nudge's `notify_last_refill_<id>` marker. The pure
// state machine is lib/coaching's nextRestEpisode; this layer just reads/writes
// the marker. Reads feed gatherCoachingInput so the rendered nudge can phrase a
// continuing stretch; the write is owned by the notify tick (reconcileRestEpisode)
// so the episode advances day-over-day even on days the dashboard isn't opened.
const REST_EPISODE_KEY = "coaching_rest_episode";

// The stored episode marker for a profile, or null when none is open / unparseable.
export function getRestEpisode(profileId: number): RestEpisode | null {
  const raw = getProfileSetting(profileId, REST_EPISODE_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<RestEpisode>;
    if (
      p &&
      typeof p.startDate === "string" &&
      typeof p.lastDate === "string" &&
      typeof p.reasonId === "string"
    ) {
      return {
        startDate: p.startDate,
        lastDate: p.lastDate,
        reasonId: p.reasonId,
      };
    }
  } catch {
    // Corrupt marker → treat as no episode; the next reconcile overwrites it.
  }
  return null;
}

function saveRestEpisode(profileId: number, ep: RestEpisode | null): void {
  if (ep) setProfileSetting(profileId, REST_EPISODE_KEY, JSON.stringify(ep));
  else deleteProfileSetting(profileId, REST_EPISODE_KEY);
}

// Advance or clear the persisted rest episode from today's ranked recommendations,
// mirroring the refill nudge's episode dedup: a rest rec (re)marks the episode; a
// day with no rest rec ends it. Idempotent within a day (re-running yields the
// same marker, so no needless write). Returns the reconciled episode. Called by
// the notify tick per profile so the marker tracks the CONDITION daily, not just
// on days the user views a coaching surface.
export function reconcileRestEpisode(
  profileId: number,
  recs: Recommendation[],
  todayStr: string
): RestEpisode | null {
  const prev = getRestEpisode(profileId);
  const rest = recs.find((r) => r.kind === "rest") ?? null;
  const next = nextRestEpisode(prev, rest, todayStr);
  if (JSON.stringify(prev) !== JSON.stringify(next))
    saveRestEpisode(profileId, next);
  return next;
}

// Convenience for the notify tick: gather this profile's coaching input, rank it,
// and reconcile the rest episode. Units don't affect the rest decision, so plain
// canonical defaults are fine here. Returns the reconciled episode.
//
// The full gather (complete strength/cardio scan + 42×1440 HR-minute rows) is the
// tick's heaviest per-profile read, and the workout-reminder slot runs the IDENTICAL
// gather in the same tick (recommendWorkout) — request-scoped caching is a no-op
// outside Next (#386), so the tick did it twice. `input` lets the caller pass a
// gather it already computed this tick so both consumers share ONE scan (#447).
export function runCoachingEpisode(
  profileId: number,
  input?: CoachingInput
): RestEpisode | null {
  const recs = recommendCoaching(
    input ?? gatherCoachingInput(profileId, "kg", "km")
  );
  return reconcileRestEpisode(profileId, recs, today(profileId));
}
