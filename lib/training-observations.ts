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
// Pure and client-safe — no DB/network. The DB gather lives in lib/rule-findings.ts
// (buildTrainingObservationFindings), which maps each finding into the shared Finding
// envelope carrying the stable dedupeKey below so a page dismiss/snooze silences it
// (issue #227); these render on the Training tab. Every threshold is a named constant
// with its rationale; the boundaries are unit-tested in
// lib/__tests__/training-observations.test.ts.

import { liftInfo, type MovementPattern } from "./lifts";
import { theilSenSlopePerDay, median, type DatedPoint } from "./robust-stats";

// ---- Shared finding shape -------------------------------------------------

// The kinds of observation this module emits — each maps to one Upcoming domain.
export type TrainingObservationKind = "balance" | "stale" | "plateau";

export interface TrainingObservation {
  kind: TrainingObservationKind;
  // Stable suppression/identity key (the UpcomingItem key === dedupeKey). See the
  // *SignalKey helpers below — the single source of truth so the finding and any
  // future push line up on the same string. Now carries an EPISODE anchor (#436)
  // so a dismissal is "this episode", not "this topic forever".
  key: string;
  // The pre-#436, episode-less shape of `key`. A dismissal stored under the old key
  // still suppresses the CURRENT finding through Finding.supersedes (dual-read), so
  // upgrading the key shape never orphans a live dismissal. New dismissals write the
  // episodic `key`. See lib/findings.activeFindings + lib/rule-findings.
  legacyKey: string;
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

// e1RM level bucket (kg) the plateau episode anchor rounds to. Coarse enough that a
// plateau holding at the same load keeps ONE anchor (so a dismissal sticks across the
// rolling window), fine enough that breaking to a new working weight and re-stalling
// there is a NEW episode that re-fires (#436).
export const PLATEAU_LEVEL_BUCKET_KG = 5;

// ---- Legacy (pre-#436, episode-less) key builders ----
// The old key shapes, kept only so a dismissal stored before #436 still suppresses
// the current finding via Finding.supersedes rather than orphaning. Never written as
// a fresh dismissal — the *SignalKey builders below (with the episode anchor) are.

export function trainingBalanceLegacyKey(): string {
  return `${TRAINING_OBS_PREFIX}balance:push-pull`;
}

export function staleExerciseLegacyKey(exercise: string): string {
  return `${TRAINING_OBS_PREFIX}stale:${exercise.trim().toLowerCase()}`;
}

export function plateauLegacyKey(exercise: string): string {
  return `${TRAINING_OBS_PREFIX}plateau:${exercise.trim().toLowerCase()}`;
}

// ---- Episodic key builders (#436) ----

// One push/pull balance finding per profile, keyed by the SKEWED DIRECTION ("push" or
// "pull") — mirroring the digest's direction component, so a dismissal of a
// push-heavy skew doesn't also silence a later pull-heavy one (a flip re-fires).
export function trainingBalanceSignalKey(heavier: "push" | "pull"): string {
  return `${trainingBalanceLegacyKey()}:${heavier}`;
}

// A stale finding keyed by the exercise AND the lapse anchor (the YYYY-MM of the last
// session before it went quiet): training it again then letting it lapse afresh moves
// the anchor forward → a new episode re-fires; the same lapse keeps one anchor.
export function staleExerciseSignalKey(
  exercise: string,
  lapseAnchor: string
): string {
  return `${staleExerciseLegacyKey(exercise)}:${lapseAnchor}`;
}

// A plateau finding keyed by the exercise AND the e1RM level bucket: a NEW plateau at
// a different working weight lands in a new bucket → re-fires; a plateau holding at
// the same load keeps one anchor so the dismissal sticks.
export function plateauSignalKey(
  exercise: string,
  levelAnchor: string
): string {
  return `${plateauLegacyKey(exercise)}:${levelAnchor}`;
}

// The e1RM-level episode anchor for a plateau (the working load bucketed to
// PLATEAU_LEVEL_BUCKET_KG). Pure integer bucket so it's a stable string across ticks.
export function plateauLevelAnchor(levelKg: number): string {
  return String(Math.round(levelKg / PLATEAU_LEVEL_BUCKET_KG));
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
  const heavierSide = push >= pull ? "push" : "pull";
  const heavier = push >= pull ? "pushing" : "pulling";
  const lighter = push >= pull ? "pulling" : "pushing";
  return {
    kind: "balance",
    key: trainingBalanceSignalKey(heavierSide),
    legacyKey: trainingBalanceLegacyKey(),
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
        // Episode anchor = the YYYY-MM of the last session before the lapse.
        key: staleExerciseSignalKey(s.exercise, s.lastDate.slice(0, 7)),
        legacyKey: staleExerciseLegacyKey(s.exercise),
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

// The rep-progression escape hatch (#432.2). estimate1RM caps its rep bonus at
// E1RM_REP_CAP (12), so a fixed-load HIGH-REP progression (12→15→18 reps at the same
// weight — lateral raises, curls, calf work) produces a capped-FLAT e1RM series that
// isPlateau would call a plateau, telling a genuinely-progressing lifter to deload.
// When reps at the top load are trending up by at least this many across the window,
// the "flat" e1RM is a cap artifact, not a stall — skip the finding. Two reps over
// six weeks is a real, sustained rep gain (not session-to-session noise).
export const PLATEAU_REP_PROGRESSION_MIN = 2;

// One exercise's dated best-per-session estimated 1RM (kg), for plateau detection.
// Each point also carries the rep count of that day's best set, so the rep-progression
// escape hatch can distinguish a true plateau from cap-flattened high-rep progression.
export interface E1rmPoint extends DatedPoint {
  reps?: number; // reps of the best-e1RM set that day (for the escape hatch)
}
export interface E1rmSeries {
  exercise: string;
  points: E1rmPoint[]; // { date, value: e1rmKg, reps }, any order
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

// Whether reps are genuinely trending UP across the window — the signal that a
// cap-flattened e1RM series is high-rep progression, not a stall (#432.2). Fits the
// robust slope over the per-day rep counts and asks whether the modeled gain clears
// PLATEAU_REP_PROGRESSION_MIN. Returns false when reps aren't tracked on the points.
export function repsProgressing(points: readonly E1rmPoint[]): boolean {
  const repPoints: DatedPoint[] = points
    .filter((p) => p.reps != null && p.reps > 0)
    .map((p) => ({ date: p.date, value: p.reps as number }));
  if (repPoints.length < PLATEAU_MIN_POINTS) return false;
  const slope = theilSenSlopePerDay(repPoints);
  if (slope == null || slope <= 0) return false;
  return slope * PLATEAU_WINDOW_DAYS >= PLATEAU_REP_PROGRESSION_MIN;
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
    // A flat e1RM with rising reps at a fixed load is progression the rep cap hid,
    // not a stall — don't advise a deload (#432.2).
    if (repsProgressing(windowed)) continue;
    // Episode anchor = the plateau's e1RM level bucket (its median working load), so
    // a new plateau at a different weight re-fires while this one stays dismissed.
    const levelAnchor = plateauLevelAnchor(
      median(windowed.map((p) => p.value))
    );
    out.push({
      kind: "plateau",
      key: plateauSignalKey(s.exercise, levelAnchor),
      legacyKey: plateauLegacyKey(s.exercise),
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
