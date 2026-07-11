// Deterministic, observational training-balance findings (issue #45, domain 4).
// Three pure checks over a profile's recent strength history, surfaced as calm,
// dismissible findings on the shared findings bus (Upcoming): a push/pull volume
// imbalance, an exercise that has gone stale (in rotation but untrained for a few
// weeks), and a plateaued lift (estimated-1RM flat for ~6 weeks).
//
// These are OBSERVATIONS, not "what to train" recommendations — they deliberately
// do NOT compete with the unified workout-recommendation core
// (lib/workout-recommendation.ts, #221). The plateau suggestion is phrased with the
// double-progression engine's vocabulary (lib/coaching.ts): a deload (drop the load
// and rebuild) or a variation to restart progression.
//
// Pure and client-safe — no DB/network. The DB gather lives in
// lib/queries/upcoming.ts, which maps each finding to an UpcomingItem carrying the
// stable dedupeKey below so a page dismiss/snooze silences it (issue #227). Every
// threshold is a named constant with its rationale; the boundaries are unit-tested
// in lib/__tests__/training-observations.test.ts.

import { liftInfo, type MovementPattern } from "./lifts";
import { theilSenSlopePerDay, median, type DatedPoint } from "./robust-stats";

// ---- Shared finding shape -------------------------------------------------

// The kinds of observation this module emits — each maps to one Upcoming domain.
export type TrainingObservationKind = "balance" | "stale" | "plateau";

export interface TrainingObservation {
  kind: TrainingObservationKind;
  // Stable suppression/identity key (the UpcomingItem key === dedupeKey). See the
  // *SignalKey helpers below — the single source of truth so the finding and any
  // future push line up on the same string.
  key: string;
  title: string;
  detail: string;
  // The exercise a stale/plateau finding is about (null for the push/pull balance
  // finding, which spans the whole rotation). Used for the deep link + re-key.
  exercise: string | null;
}

// ---- Signal keys (single source of truth) ---------------------------------
//
// Every training-observation finding shares ONE dedupeKey namespace
// (`training-obs:`) so the page's dismiss action can guard the whole domain with a
// single prefix check (mirroring the trajectory/digest actions, #39/#41). The kind
// segment keeps the three checks collision-free within the namespace.
export const TRAINING_OBS_PREFIX = "training-obs:";

// One push/pull balance finding per profile — keyed by the axis it describes.
export function trainingBalanceSignalKey(): string {
  return `${TRAINING_OBS_PREFIX}balance:push-pull`;
}

export function staleExerciseSignalKey(exercise: string): string {
  return `${TRAINING_OBS_PREFIX}stale:${exercise.trim().toLowerCase()}`;
}

export function plateauSignalKey(exercise: string): string {
  return `${TRAINING_OBS_PREFIX}plateau:${exercise.trim().toLowerCase()}`;
}

// ---- 1. Push/pull volume imbalance ----------------------------------------

// Trailing window the balance check sums over — four weeks, per the issue. A month
// smooths a single lopsided session while still reflecting the CURRENT split.
export const BALANCE_WINDOW_DAYS = 28;

// The larger side must be at least this many times the smaller before we flag a
// skew. 2× (twice as much pushing as pulling, or vice versa) is a pronounced,
// physique/injury-relevant imbalance — not the normal week-to-week wobble a
// tighter ratio would nag about.
export const PUSH_PULL_RATIO = 2;

// …and only once there's enough total pushing+pulling work to trust the ratio, so
// a light week (a couple of sets) isn't flagged as "imbalanced". Twelve sets over
// four weeks is a real training signal.
export const MIN_PUSH_PULL_SETS = 12;

// One exercise's set count over the balance window.
export interface ExerciseSetCount {
  exercise: string;
  sets: number;
}

// Sum set counts into movement patterns via the lift catalog. Only push/pull are
// returned here — the balance finding is a push↔pull axis; legs/core don't have a
// meaningful antagonist pairing to compare.
export function patternSetCounts(counts: readonly ExerciseSetCount[]): {
  push: number;
  pull: number;
} {
  let push = 0;
  let pull = 0;
  for (const c of counts) {
    const pattern: MovementPattern | undefined = liftInfo(c.exercise)?.pattern;
    if (pattern === "push") push += c.sets;
    else if (pattern === "pull") pull += c.sets;
  }
  return { push, pull };
}

// A push/pull imbalance finding, or null when the split is balanced / too little
// data. Fires when one side is ≥ PUSH_PULL_RATIO× the other AND the combined set
// count clears MIN_PUSH_PULL_SETS.
export function detectPushPullImbalance(
  counts: readonly ExerciseSetCount[]
): TrainingObservation | null {
  const { push, pull } = patternSetCounts(counts);
  const total = push + pull;
  if (total < MIN_PUSH_PULL_SETS) return null;
  // Guard the zero-side case: any work vs none is an imbalance once the total bar
  // is met, but ratio math needs a non-zero denominator.
  const hi = Math.max(push, pull);
  const lo = Math.min(push, pull);
  if (lo > 0 && hi < PUSH_PULL_RATIO * lo) return null;
  if (lo === 0 && hi === 0) return null;
  const heavier = push >= pull ? "pushing" : "pulling";
  const lighter = push >= pull ? "pulling" : "pushing";
  return {
    kind: "balance",
    key: trainingBalanceSignalKey(),
    title: "Push/pull balance is skewed",
    detail:
      `Over the last 4 weeks you logged ${push} pushing and ${pull} pulling ` +
      `sets — noticeably more ${heavier} than ${lighter}. Adding a little more ` +
      `${lighter} volume keeps the two sides in balance.`,
    exercise: null,
  };
}

// ---- 2. Stale exercise ----------------------------------------------------

// An exercise counts as ESTABLISHED (worth noticing when it lapses) only after
// this many sessions — below it, a one-or-two-off isn't a rotation staple.
export const STALE_MIN_SESSIONS = 3;

// The "in rotation but untrained" band. Fewer than 3 weeks isn't stale yet (a
// normal gap between hitting a muscle); past ~8 weeks the lift reads as dropped
// from the program, not merely stale, so we stop nagging.
export const STALE_MIN_DAYS = 21;
export const STALE_MAX_DAYS = 56;

// Whole days from an ISO date to `today`, or Infinity if unparseable.
function daysSince(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

// The per-exercise slice the stale check reads (ExerciseStat satisfies it).
export interface StaleExerciseInput {
  exercise: string;
  sessions: number;
  lastDate: string;
}

// Established exercises last trained STALE_MIN_DAYS…STALE_MAX_DAYS ago — recently
// enough to still be "your routine", long enough that they've lapsed. Newest-lapse
// first (most recently trained → most likely still intended).
export function detectStaleExercises(
  stats: readonly StaleExerciseInput[],
  today: string
): TrainingObservation[] {
  const out: { obs: TrainingObservation; ago: number }[] = [];
  for (const s of stats) {
    if (s.sessions < STALE_MIN_SESSIONS) continue;
    const ago = daysSince(s.lastDate, today);
    if (ago < STALE_MIN_DAYS || ago > STALE_MAX_DAYS) continue;
    const weeks = Math.round(ago / 7);
    out.push({
      ago,
      obs: {
        kind: "stale",
        key: staleExerciseSignalKey(s.exercise),
        title: `${s.exercise} has gone quiet`,
        detail:
          `You trained ${s.exercise} regularly but haven't in about ${weeks} ` +
          `weeks. If it's still part of your plan, work it back into the rotation.`,
        exercise: s.exercise,
      },
    });
  }
  return out.sort((a, b) => a.ago - b.ago).map((x) => x.obs);
}

// ---- 3. Plateau / deload --------------------------------------------------

// The trailing window the plateau check fits its robust slope over — six weeks, per
// the issue. Long enough that genuine progression would show; short enough that an
// old plateau you've since broken doesn't linger.
export const PLATEAU_WINDOW_DAYS = 42;

// A plateau needs an ESTABLISHED lift with enough recent sessions to trust a flat
// slope — four dated e1RM points inside the window.
export const PLATEAU_MIN_POINTS = 4;

// …spanning at least this many days, so four sessions crammed into one week can't
// read as a six-week plateau.
export const PLATEAU_MIN_SPAN_DAYS = 21;

// Flat means the modeled change across the whole window is under this fraction of
// the lift's typical e1RM (≈1.5%). A truly progressing lift clears this easily; MDC
// (minimal detectable change) for estimated 1RM is a few percent, so ~1.5% over six
// weeks is indistinguishable from no progress.
export const PLATEAU_FLAT_FRACTION = 0.015;

// One exercise's dated best-per-session estimated 1RM (kg), for plateau detection.
export interface E1rmSeries {
  exercise: string;
  points: DatedPoint[]; // { date, value: e1rmKg }, any order
}

// Whether a single lift's windowed e1RM series is flat (a plateau). Pure over the
// points; the caller windows to the last PLATEAU_WINDOW_DAYS.
export function isPlateau(points: readonly DatedPoint[]): boolean {
  if (points.length < PLATEAU_MIN_POINTS) return false;
  const dates = points.map((p) => p.date).sort();
  const spanDays = daysSince(dates[0], dates[dates.length - 1]);
  if (spanDays < PLATEAU_MIN_SPAN_DAYS) return false;
  const slope = theilSenSlopePerDay(points);
  if (slope == null) return false;
  const level = median(points.map((p) => p.value));
  if (!(level > 0)) return false;
  const modeledChange = Math.abs(slope) * PLATEAU_WINDOW_DAYS;
  return modeledChange < PLATEAU_FLAT_FRACTION * level;
}

// Plateaued lifts: established series whose windowed e1RM is flat. `today` windows
// each series to the trailing PLATEAU_WINDOW_DAYS. Alphabetical for deterministic
// ordering across surfaces.
export function detectPlateaus(
  series: readonly E1rmSeries[],
  today: string
): TrainingObservation[] {
  const cutoffAgo = PLATEAU_WINDOW_DAYS;
  const out: TrainingObservation[] = [];
  for (const s of series) {
    const windowed = s.points.filter((p) => {
      const ago = daysSince(p.date, today);
      return ago >= 0 && ago <= cutoffAgo && p.value > 0;
    });
    if (!isPlateau(windowed)) continue;
    out.push({
      kind: "plateau",
      key: plateauSignalKey(s.exercise),
      title: `${s.exercise} has plateaued`,
      detail:
        `Your estimated 1RM for ${s.exercise} has been flat for about 6 weeks. ` +
        `A short deload — drop the load ~10% and rebuild — or swapping in a ` +
        `variation can restart progression.`,
      exercise: s.exercise,
    });
  }
  return out.sort((a, b) => a.exercise!.localeCompare(b.exercise!));
}
