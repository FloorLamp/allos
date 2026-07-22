import { db, today } from "../db";
import { getMainSleepNightlyMinutes } from "./sleep";
import {
  getActivityDates,
  getCardioByActivity,
  getFrequencyTargetProgress,
  getRecentDatedExercises,
  getStrengthByExercise,
} from "./training";
import { getDayLoadInputs, getIntensitySignal } from "./zones";
import { getWorkoutPresence } from "./presence";
import { loadingDates } from "../training-zones";
import {
  nextRestEpisode,
  recommendCoaching,
  type CoachingInput,
  type IllnessCoachingContext,
  type Recommendation,
  type RestAck,
  type RestEpisode,
  type RestingHrSignal,
  type SleepSignal,
} from "../coaching";
import {
  getEpisodeRowForDate,
  mostRecentClosedEpisodeRow,
} from "../illness-episode-store";
import {
  deleteProfileSetting,
  getProfileSetting,
  setProfileSetting,
  type DistanceUnit,
  type WeightUnit,
} from "../settings";
import { availableEquipmentKinds } from "../equipment";
import { getActiveRoutine, getRoutineCycleStatus } from "../routines";
import { getInjuryConstraints } from "../injuries";
import { getEnduranceArm } from "./endurance";
import { getConditions } from "./clinical";
import {
  matchConditionConsiderations,
  type ConditionConsideration,
} from "../condition-training-considerations";

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

// Last night's MAIN overnight sleep (minutes) and the recent baseline, or null
// when no sleep has been synced. Reads the per-night MAIN-session durations
// (mainSleepSession, #1118) — NOT the raw daily `sleep_min` total, which SUMS a
// same-day nap into the night on Health Connect and would mask an overnight
// deficit. Baseline is the mean of the prior nights in the window (falls back to
// all nights when only one).
export function getSleepSignal(profileId: number): SleepSignal | null {
  const nights = getMainSleepNightlyMinutes(profileId, RECOVERY_BASELINE_DAYS); // oldest → newest, main overnight session per night
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
// The situation-aware coaching context (issue #837): the open flagged-illness
// episode state + the most-recently-closed episode, read from the ONE
// illness_episodes derivation (#856) — the SAME rows the illness hero/timeline use,
// never a second engine. A row covering today = an open episode (held); the most
// recent closed row anchors the ease-back ramp (the pure engine applies the window).
export function getIllnessCoachingContext(
  profileId: number,
  todayStr: string
): IllnessCoachingContext {
  const openRow = getEpisodeRowForDate(profileId, todayStr);
  const lastClosed = mostRecentClosedEpisodeRow(profileId);
  return {
    openEpisode: openRow != null,
    lastClosed:
      lastClosed && lastClosed.ended_at != null
        ? { episodeId: lastClosed.id, endDate: lastClosed.ended_at }
        : null,
  };
}

// The curated condition→training CONSIDERATION notes (#666) for the profile's ACTIVE
// mapped conditions — the REAL gather every surface's coaching input threads through. Reads
// the active problem list (profile-scoped via getConditions) and resolves each against the
// curated dataset (matchConditionConsiderations). Note-only: it never gates or re-ranks.
export function getConditionConsiderations(
  profileId: number
): ConditionConsideration[] {
  const conditions = getConditions(profileId, { status: "active" });
  return matchConditionConsiderations(
    conditions.map((c) => ({ name: c.name, code: c.code }))
  );
}

export function gatherCoachingInput(
  profileId: number,
  weightUnit: WeightUnit,
  distanceUnit: DistanceUnit
): CoachingInput {
  const todayStr = today(profileId);
  const illness = getIllnessCoachingContext(profileId, todayStr);
  return {
    today: todayStr,
    illness,
    // User-declared injury constraints (#838) + curated condition considerations (#666) —
    // threaded through the ONE gather so every surface excludes/tempers/notes identically.
    injuries: getInjuryConstraints(profileId),
    considerations: getConditionConsiderations(profileId),
    // Plan-aware cardio arm (#839): the soonest active endurance plan's calm note, with the
    // illness pause (#837) applied here so an open episode holds the nagging note.
    endurancePlanArm: getEnduranceArm(profileId, todayStr, illness.openEpisode),
    routine: getFrequencyTargetProgress(profileId),
    strength: getStrengthByExercise(profileId),
    cardio: getCardioByActivity(profileId, distanceUnit),
    trainingDates: getActivityDates(profileId),
    loadingDates: loadingDates(getDayLoadInputs(profileId)),
    datedExercises: getRecentDatedExercises(profileId),
    availableEquipment: availableEquipmentKinds(profileId),
    activeRoutine: getActiveRoutine(profileId),
    deloadWeek:
      getRoutineCycleStatus(profileId, todayStr)?.isDeloadWeek ?? false,
    sleep: getSleepSignal(profileId),
    restingHr: getRestingHrSignal(profileId),
    restEpisode: getRestEpisode(profileId),
    // "Training anyway" acknowledgment (#1150): when set for today, the rest slot
    // renders calm training guidance instead of a rest nudge. Read here so every
    // surface (dashboard card, overview, Telegram) reflects the choice (one computation).
    restAck: getRestAck(profileId, todayStr),
    intensity: getIntensitySignal(profileId),
    // Derived workout presence (#921) → the rest card's TENSE only. `active` softens
    // "rest today" to next-session framing so the advice never contradicts a session
    // the user is in the middle of. One computation, read here so every surface agrees.
    workoutActive: getWorkoutPresence(profileId).state === "active",
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

// ---- "Training anyway" acknowledgment persistence (#1150) ----
//
// A per-day declaration of intent — DISTINCT from the #39 snooze store (an
// acknowledgment is not a dismissal, so it never touches upcoming_dismissals). Stored
// in ONE per-profile profile_settings row (JSON), the way the rest episode marker is;
// profile_settings is a settings tier (not profile-owned data), so no migration /
// owned-tables entry is needed. Today-only by construction: getRestAck returns the
// marker ONLY when its date matches the caller's `today`, so a stale (yesterday's)
// marker is ignored and a still-firing signal re-evaluates fresh — the ack can never
// silence a persisting signal for good.
const REST_ACK_KEY = "coaching_rest_ack";

// The stored acknowledgment for `todayStr`, or null when there's none for today (a
// past-date or unparseable marker reads as absent). Profile-scoped via profile_settings.
export function getRestAck(
  profileId: number,
  todayStr: string
): RestAck | null {
  const raw = getProfileSetting(profileId, REST_ACK_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<RestAck>;
    if (
      p &&
      typeof p.date === "string" &&
      p.date === todayStr &&
      Array.isArray(p.reasonIds) &&
      p.reasonIds.every((r) => typeof r === "string")
    ) {
      return { date: p.date, reasonIds: p.reasonIds };
    }
  } catch {
    // Corrupt marker → treat as no acknowledgment; the next write overwrites it.
  }
  return null;
}

// Record the "Training anyway" acknowledgment for TODAY with the firing reason ids
// (the signals the user acknowledged). Overwrites any prior same-day marker; a new day
// makes the prior one stale (getRestAck ignores it). Auth-blind write core (#319):
// the Server Action owns the auth gate. Single-statement write via setProfileSetting.
export function acknowledgeRestToday(
  profileId: number,
  reasonIds: string[]
): void {
  const ack: RestAck = { date: today(profileId), reasonIds };
  setProfileSetting(profileId, REST_ACK_KEY, JSON.stringify(ack));
}
