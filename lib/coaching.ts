// Training coaching: turn logged history into a concrete next-set target
// (double progression) and detect personal records to celebrate, for both
// strength and cardio. Pure and client-safe — no DB/network — so it runs in
// components and under test.
import { isTimed, liftInfo, type MuscleRegion } from "./lifts";
import { estimate1RM } from "./strength";
import { frequencyScopeLabel } from "./goals";
import { formatRelativeDate } from "./format-date";
import { shiftDateStr } from "./date";
import { currentStreak } from "./streak";
import { dispWeight, kgTo, toKg, round } from "./units";
import { classifyPolarization, type PolarizedSplit } from "./training-zones";
import {
  recommendNextWorkout,
  VARIETY_LOOKBACK_DAYS,
  type DatedExercise,
  type NextWorkout,
  type NextWorkoutItem,
} from "./workout-recommendation";
import type { WeightUnit } from "./settings";

// Re-exported so existing importers of the variety window keep working — its
// single definition now lives with the unified next-workout core (#221).
export { VARIETY_LOOKBACK_DAYS };

// ---- Strength ----

// The slice of per-exercise stats this module needs. ExerciseStat (lib/queries)
// structurally satisfies it; a local shape keeps coaching decoupled from the DB
// layer and trivially testable.
export interface ExerciseSummary {
  exercise: string;
  sessions: number; // distinct dates trained
  bodyweight: boolean; // body is (part of) the load — progress by reps
  e1rmKg: number;
  bestWeightKg: number;
  bestReps: number;
  bestDate: string; // date of the all-time best estimated 1RM
  topWeightKg: number;
  topWeightDate: string; // date the heaviest load was first hit
  lastDate: string; // most recent date trained
  // Best working set of the most recent session, used to seed progression.
  // targetReps/toFailure carry that set's declared intent when one was logged;
  // optional so plain {weight, reps} summaries keep working.
  lastSessionBest: {
    weightKg: number;
    reps: number;
    targetReps?: number | null;
    toFailure?: boolean;
  } | null;
}

// Single-joint movements progress in smaller jumps and higher rep ranges than
// compound lifts. Matched by movement name (plus the Arms region, all isolation).
const ISOLATION_RE =
  /curl|extension|raise|fly|pushdown|kickback|shrug|pec deck|crunch|adduction|abduction|face pull|wrist|calf/i;

export function isIsolation(exercise: string): boolean {
  if (liftInfo(exercise)?.region === "Arms") return true;
  return ISOLATION_RE.test(exercise);
}

// Working rep range for double progression: compounds 5–8, isolation 8–12.
export function repRangeFor(exercise: string): { low: number; high: number } {
  return isIsolation(exercise) ? { low: 8, high: 12 } : { low: 5, high: 8 };
}

// Smallest sensible load jump (kg): big lower-body compounds take 5 kg;
// isolation and upper-body accessories take 2.5 kg.
export function weightIncrementKg(exercise: string): number {
  if (isIsolation(exercise)) return 2.5;
  if (/squat|deadlift|leg press|hip thrust/i.test(exercise)) return 5;
  const region = liftInfo(exercise)?.region;
  return region === "Legs" || region === "Glutes" ? 5 : 2.5;
}

// The same jump for lb loading: 10 lb for the big lower-body lifts, 5 lb
// otherwise. Native lb steps (not converted kg) so targets stay plate-loadable.
export function weightIncrementLb(exercise: string): number {
  return weightIncrementKg(exercise) === 5 ? 10 : 5;
}

export interface NextSet {
  weightKg: number; // 0 for a bodyweight movement
  reps: number;
  bodyweight: boolean;
  // The declared rep target the suggestion progresses toward, when it came from
  // the user's scheme (null for heuristic suggestions). Logging the next
  // session with this intent keeps target-driven progression going.
  targetReps: number | null;
  rationale: string;
}

// The suggested top set as display text: "62.5 kg × 5", or "BW × 13" for
// bodyweight lifts.
export function nextSetText(ns: NextSet, wu: WeightUnit): string {
  if (ns.bodyweight) return `BW × ${ns.reps}`;
  return `${dispWeight(ns.weightKg, wu, 1)} ${wu} × ${ns.reps}`;
}

// The set shape sessionBestSet reads — matches the recent-session history the
// activity editor is shipped (lib/queries' RecentSession sets).
interface SessionSet {
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  target_reps?: number | null;
  to_failure?: number | null;
}

// The seeding set of one session: highest estimated 1RM, then most reps —
// mirroring getStrengthByExercise's lastSessionBest so a suggestion built from
// shipped history matches the exercise detail panel's. Each side of a per-side
// set is its own candidate. `baseKg` folds the user's bodyweight into the load
// for bodyweight movements (pass 0 otherwise). Null when no set has reps.
export function sessionBestSet(
  sets: SessionSet[],
  baseKg = 0
): {
  weightKg: number;
  reps: number;
  targetReps: number | null;
  toFailure: boolean;
} | null {
  let best: ReturnType<typeof sessionBestSet> = null;
  let bestE1rm = -1;
  for (const s of sets) {
    const sides: { weight: number; reps: number }[] = [];
    if (s.reps != null)
      sides.push({ weight: baseKg + (s.weight_kg ?? 0), reps: s.reps });
    if (s.reps_right != null)
      sides.push({
        weight: baseKg + (s.weight_kg_right ?? 0),
        reps: s.reps_right,
      });
    for (const side of sides) {
      const e1rm = estimate1RM(side.weight, side.reps);
      if (e1rm > bestE1rm || (e1rm === bestE1rm && side.reps > best!.reps)) {
        bestE1rm = e1rm;
        best = {
          weightKg: side.weight,
          reps: side.reps,
          targetReps: s.target_reps ?? null,
          toFailure: s.to_failure === 1,
        };
      }
    }
  }
  return best;
}

// The load after one increment, chosen in the user's unit so it stays loadable.
// kg users get the canonical 2.5/5 kg jump; lb users get a native 5/10 lb jump
// snapped to the nearest multiple of 5 lb (a plate-loadable number, not a
// converted-kg fraction like 181.9 lb). weightKg stays canonical; incDisp is
// the jump in `wu` for the rationale text.
function addIncrement(
  exercise: string,
  lastKg: number,
  wu: WeightUnit
): { weightKg: number; incDisp: number } {
  if (wu === "lb") {
    const incLb = weightIncrementLb(exercise);
    // When the last weight is already a multiple of 5 lb (the norm for an lb
    // lifter) this is exactly lastLb + incLb; a kg-entered oddball still lands
    // on a loadable number nearby.
    const nextLb = Math.round((kgTo(lastKg, "lb") + incLb) / 5) * 5;
    return { weightKg: toKg(nextLb, "lb"), incDisp: incLb };
  }
  const inc = weightIncrementKg(exercise);
  return { weightKg: lastKg + inc, incDisp: round(inc, 1) };
}

// Suggest the next session's top set off the last session's best set.
//
// When that set declared a rep target (set intent, not AMRAP), progression
// honors the user's scheme instead of the heuristic range:
//   reps at/above the target → add weight, keep the same rep target
//   reps below the target    → hold weight, build to the target
// Otherwise (no intent, or a to-failure set), double progression within the
// heuristic range:
//   reps at/above the range top → add weight, reset to the bottom of the range
//   reps below the range bottom → hold weight, build back to the bottom
//   reps within the range       → hold weight, chase one more rep
// Bodyweight movements progress by reps; timed holds (planks) get no suggestion.
//
// Takes just the slice of ExerciseSummary it reads, so callers without full
// stats (the activity editor, seeding from shipped history via sessionBestSet)
// can call it too.
export type NextSetSeed = Pick<
  ExerciseSummary,
  "exercise" | "bodyweight" | "lastSessionBest"
>;
export function suggestNextSet(
  s: NextSetSeed,
  wu: WeightUnit = "kg"
): NextSet | null {
  if (isTimed(s.exercise)) return null;
  const last = s.lastSessionBest;
  if (!last) return null;

  // Declared rep target of the seeding set. An AMRAP has no meaningful rep
  // plan (its count is an outcome, not a goal), so it falls to the heuristic.
  const target = last.toFailure ? null : (last.targetReps ?? null);

  if (s.bodyweight) {
    if (target != null && last.reps < target) {
      return {
        weightKg: 0,
        reps: target,
        bodyweight: true,
        targetReps: target,
        rationale: `Build to your ${target}-rep target`,
      };
    }
    return {
      weightKg: 0,
      reps: last.reps + 1,
      bodyweight: true,
      targetReps: null,
      rationale: `Beat ${last.reps} reps`,
    };
  }

  if (target != null) {
    if (last.reps >= target) {
      const { weightKg, incDisp } = addIncrement(s.exercise, last.weightKg, wu);
      return {
        weightKg,
        reps: target,
        bodyweight: false,
        targetReps: target,
        rationale: `Hit your ${target}-rep target — add ${incDisp} ${wu}`,
      };
    }
    return {
      weightKg: last.weightKg,
      reps: target,
      bodyweight: false,
      targetReps: target,
      rationale: `Build to your ${target}-rep target at this weight`,
    };
  }

  const { low, high } = repRangeFor(s.exercise);

  if (last.reps >= high) {
    const { weightKg, incDisp } = addIncrement(s.exercise, last.weightKg, wu);
    return {
      weightKg,
      reps: low,
      bodyweight: false,
      targetReps: null,
      rationale: `Hit ${last.reps} reps last time — add ${incDisp} ${wu} and reset to ${low}`,
    };
  }
  if (last.reps < low) {
    return {
      weightKg: last.weightKg,
      reps: low,
      bodyweight: false,
      targetReps: null,
      rationale: `Build back to ${low} reps at this weight`,
    };
  }
  return {
    weightKg: last.weightKg,
    reps: last.reps + 1,
    bodyweight: false,
    targetReps: null,
    rationale: `Add a rep toward ${high}`,
  };
}

// Whether the most recent session set a new all-time record. Gated on more than
// one session so a brand-new exercise's first log isn't flagged as a "record".
// Weight PRs are meaningless for bodyweight lifts (their "top weight" tracks
// bodyweight), so they're suppressed there.
export function lastSessionPR(s: ExerciseSummary): {
  e1rm: boolean;
  weight: boolean;
} {
  const established = s.sessions > 1;
  return {
    e1rm: established && s.bestDate === s.lastDate,
    weight:
      established &&
      !s.bodyweight &&
      s.topWeightKg > 0 &&
      s.topWeightDate === s.lastDate,
  };
}

export interface PR {
  exercise: string;
  kind: "1rm" | "weight";
  date: string;
  e1rmKg: number;
  weightKg: number;
  reps: number;
  // Body is (part of) the load — render "BW × reps", not an absolute weight
  // (weightKg folds in bodyweight for these lifts, so it's not a plate count).
  bodyweight: boolean;
}

// Whole days from dateISO to today (both YYYY-MM-DD), or Infinity if unparseable.
function daysAgo(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

function within(dateISO: string, today: string, days: number): boolean {
  const d = daysAgo(dateISO, today);
  return d >= 0 && d <= days;
}

// Newest-first sort by ISO date string.
function byDateDesc<T extends { date: string }>(a: T, b: T): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

// Strength records set within the last `withinDays`, newest first. An exercise
// can contribute both a 1RM PR and a separately dated top-weight PR. Bodyweight
// lifts have no weight PR. First-ever logs (one session) are excluded.
export function recentPRs(
  stats: ExerciseSummary[],
  today: string,
  withinDays = 30
): PR[] {
  const prs: PR[] = [];
  for (const s of stats) {
    if (s.sessions < 2) continue;
    if (within(s.bestDate, today, withinDays)) {
      prs.push({
        exercise: s.exercise,
        kind: "1rm",
        date: s.bestDate,
        e1rmKg: s.e1rmKg,
        weightKg: s.bestWeightKg,
        reps: s.bestReps,
        bodyweight: s.bodyweight,
      });
    }
    if (
      !s.bodyweight &&
      s.topWeightKg > 0 &&
      s.topWeightDate !== s.bestDate &&
      within(s.topWeightDate, today, withinDays)
    ) {
      prs.push({
        exercise: s.exercise,
        kind: "weight",
        date: s.topWeightDate,
        e1rmKg: s.e1rmKg,
        weightKg: s.topWeightKg,
        reps: 0,
        bodyweight: false, // gated on !s.bodyweight above
      });
    }
  }
  return prs.sort(byDateDesc);
}

// ---- Cardio ----

// Average speed in km/h, or null when distance or duration is missing/zero
// (can't derive a speed). Unit-agnostic, for comparison and ranking.
export function speedKmh(
  km: number | null | undefined,
  durationMin: number | null | undefined
): number | null {
  if (km == null || durationMin == null || km <= 0 || durationMin <= 0)
    return null;
  return km / (durationMin / 60);
}

// Per-cardio-activity stats this module needs for PR detection.
export interface CardioSummary {
  activity: string;
  sessions: number;
  hasDistance: boolean; // any session logged a distance (else duration-only)
  longestDistanceKm: number;
  longestDistanceDate: string;
  fastestKmh: number; // 0 when no distance-and-duration session exists
  fastestKmhDate: string;
  longestDurationMin: number;
  longestDurationDate: string;
}

export interface CardioPR {
  activity: string;
  kind: "distance" | "speed" | "duration";
  date: string;
  distanceKm: number;
  durationMin: number;
  speedKmh: number;
}

// Cardio records set within the last `withinDays`, newest first. Distance and
// speed PRs only apply when the activity has distance data; every cardio gets a
// duration PR. First-ever sessions are excluded.
export function recentCardioPRs(
  stats: CardioSummary[],
  today: string,
  withinDays = 30
): CardioPR[] {
  const prs: CardioPR[] = [];
  for (const s of stats) {
    if (s.sessions < 2) continue;
    if (
      s.hasDistance &&
      s.longestDistanceKm > 0 &&
      within(s.longestDistanceDate, today, withinDays)
    ) {
      prs.push({
        activity: s.activity,
        kind: "distance",
        date: s.longestDistanceDate,
        distanceKm: s.longestDistanceKm,
        durationMin: 0,
        speedKmh: 0,
      });
    }
    if (
      s.hasDistance &&
      s.fastestKmh > 0 &&
      within(s.fastestKmhDate, today, withinDays)
    ) {
      prs.push({
        activity: s.activity,
        kind: "speed",
        date: s.fastestKmhDate,
        distanceKm: 0,
        durationMin: 0,
        speedKmh: s.fastestKmh,
      });
    }
    if (
      s.longestDurationMin > 0 &&
      within(s.longestDurationDate, today, withinDays)
    ) {
      prs.push({
        activity: s.activity,
        kind: "duration",
        date: s.longestDurationDate,
        distanceKm: 0,
        durationMin: s.longestDurationMin,
        speedKmh: 0,
      });
    }
  }
  return prs.sort(byDateDesc);
}

// ---- Rule-based coaching engine ----
//
// A deterministic (no-AI) "one clear thing to do today" recommender. It ranks a
// small set of independently-derived recommendations and returns them
// highest-priority first, so the dashboard widget shows the top one (and can
// show a secondary), and the Training overview's next-workout card renders the
// top one — now recovery-aware.
//
// Precedence (a recovery signal OVERRIDES a "go train" nudge):
//   rest  >  cardio gap  >  strength / routine gap  >  on-track  >  setup
//
// Every rule is pure and tested at its thresholds in lib/__tests__/coaching.test.ts.

export type CoachingKind =
  "rest" | "cardio" | "strength" | "ontrack" | "setup" | "intensity";
// Visual/semantic tone the surface maps to a color: caution (ease off),
// action (go do it), positive (you're doing well), neutral (informational).
export type CoachingTone = "caution" | "action" | "positive" | "neutral";

export interface Recommendation {
  id: string;
  kind: CoachingKind;
  title: string;
  detail: string;
  tone: CoachingTone;
  actionHref?: string;
  actionLabel?: string;
  // Optional next-set hint ("62.5 kg × 5") for the Training next-workout card's
  // "Target" line. Only strength recommendations set it; other surfaces ignore it.
  target?: string;
  // The shared next-workout suggestion behind a strength recommendation (#221):
  // focus regions to emphasize and a ranked exercise list. Set only on strength
  // recs; the Telegram reminder renders these, the dashboard cards ignore them.
  focus?: MuscleRegion[];
  exercises?: string[];
}

// The weekly frequency-target progress slice the engine reads.
// FrequencyTargetProgress (lib/queries) structurally satisfies it.
export interface RoutineTargetProgress {
  target: {
    scope_kind: string; // 'type' | 'region' | 'group'
    scope_value: string;
  };
  count: number;
  per_week: number;
  met: boolean;
}

// The per-exercise strength slice the recommender reads (ExerciseStat satisfies it).
export type StrengthRecent = NextSetSeed & { lastDate: string };
// The per-cardio-activity slice the recommender reads (CardioStat satisfies it).
export interface CardioRecent {
  activity: string;
  lastDate: string;
}

// Recovery signals — nullable, so the rules simply don't fire without an
// integration syncing sleep / resting HR. Canonical units: minutes and bpm.
export interface SleepSignal {
  lastNightMin: number;
  baselineMin: number;
  // Optional dispersion of recent nightly sleep (minutes) — a stddev or MAD of
  // the baseline nights. When present, the deficit needed to trip a rest nudge
  // widens to max(fixed threshold, multiplier × spread), so a naturally variable
  // sleeper isn't flagged every noisy night (#44 item 3a). Absent ⇒ fixed
  // threshold, i.e. exactly the previous behavior.
  baselineSpreadMin?: number;
}
export interface RestingHrSignal {
  recent: number;
  baseline: number;
  // Optional dispersion of recent resting HR (bpm); same variance-aware widening
  // as SleepSignal.baselineSpreadMin. Absent ⇒ fixed threshold (prior behavior).
  baselineSpreadBpm?: number;
}

export interface CoachingThresholds {
  // Poor sleep: last night at least this many minutes below baseline …
  sleepDeficitMin: number;
  // … or below this absolute floor (minutes), regardless of baseline.
  sleepFloorMin: number;
  // Elevated resting HR: recent at least this many bpm above baseline.
  restingHrJumpBpm: number;
  // Overtraining: this many consecutive training days (ending today/yesterday) …
  overtrainingConsecutiveDays: number;
  // … or this many active days within the trailing window …
  overtrainingWindowActiveDays: number;
  // … measured over this many trailing days (inclusive of today).
  overtrainingWindowDays: number;
  // When a recovery signal carries a personal variability (spread), the deviation
  // needed to fire widens to at least this multiple of that spread — so a noisy
  // baseline needs a bigger-than-fixed jump before we nag a rest day.
  variabilitySpreadMultiplier: number;
}

export const DEFAULT_COACHING_THRESHOLDS: CoachingThresholds = {
  sleepDeficitMin: 90, // ~1.5 h under your average
  sleepFloorMin: 360, // 6 hours
  restingHrJumpBpm: 7, // ~5–10 bpm elevation reads as under-recovered
  overtrainingConsecutiveDays: 4,
  overtrainingWindowActiveDays: 6,
  overtrainingWindowDays: 7,
  variabilitySpreadMultiplier: 2, // ~2× the personal spread
};

// A run of consecutive days a rest/take-it-easy nudge has fired — the persisted
// marker that gives the recommendation continuity across days (#44 item 3b), so
// day 2 reads "second easy day" instead of a fresh alert. Stored per-profile
// (JSON in profile_settings), maintained the way the refill nudge dedups an
// episode: opened when a rest rec first fires, carried forward while it keeps
// firing on consecutive days, cleared the moment no rest rec fires.
export interface RestEpisode {
  startDate: string; // first day of the current consecutive rest run (YYYY-MM-DD)
  lastDate: string; // most recent day a rest rec fired — for consecutive-day detection
  reasonId: string; // the rest rec id that last (re)marked the episode
}

export interface CoachingInput {
  today: string; // profile-tz YYYY-MM-DD
  routine: RoutineTargetProgress[];
  strength: StrengthRecent[];
  cardio: CardioRecent[];
  // Distinct dates (YYYY-MM-DD) the profile logged any activity — powers the
  // consecutive-day / weekly-load overtraining checks.
  trainingDates: string[];
  // Bounded-window (date, exercise) rows feeding the unified next-workout core's
  // recovery-exclusion + weekday-habit + frequency-ranked exercise list (#221).
  // Optional — absent ⇒ the core falls back to aggregate least-recent picks, so
  // existing callers/tests keep their prior behavior.
  datedExercises?: DatedExercise[];
  sleep: SleepSignal | null;
  restingHr: RestingHrSignal | null;
  // The persisted rest episode as of the last reconcile (null when none is open).
  // Used only to PHRASE a continuing rest nudge — it never changes whether rest
  // fires, only how it reads. Absent ⇒ every rest nudge is phrased fresh (prior
  // behavior).
  restEpisode?: RestEpisode | null;
  // The easy/hard training-intensity split over a trailing window (issue #159),
  // or null when there's no HR zone model / no windowed HR. Drives the hard-heavy
  // "add easy Zone 2" nudge — the classic self-coached polarization failure.
  intensity?: PolarizedSplit | null;
  weightUnit?: WeightUnit; // for the next-set target text; default "kg"
  thresholds?: Partial<CoachingThresholds>;
}

function pluralSessions(n: number): string {
  return n === 1 ? "session" : "sessions";
}

// Whole days from an ISO date to `today`, or Infinity if unparseable. (Local copy
// of the strength-section helper's semantics, exported-scope-free.)
function daysSince(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

// Distinct active days within the trailing `windowDays` (inclusive of today).
export function activeDaysInWindow(
  dates: string[],
  today: string,
  windowDays: number
): number {
  let n = 0;
  for (const d of new Set(dates)) {
    const ago = daysSince(d, today);
    if (ago >= 0 && ago < windowDays) n++;
  }
  return n;
}

function hoursText(min: number): string {
  return `${(min / 60).toFixed(1)}h`;
}

// The rest/light recommendation when a strong recovery signal fires, else null.
// Reasons are checked in salience order (sleep → resting HR → overtraining); the
// first hit names the recommendation, so it always states an actual reason.
export function restRecommendation(
  input: CoachingInput,
  th: CoachingThresholds
): Recommendation | null {
  const { sleep, restingHr, trainingDates, today } = input;

  // Poor sleep — only when sleep data exists. When a personal night-to-night
  // spread is known, the deficit that counts as "poor" widens to at least
  // `multiplier × spread`, so a variable sleeper needs a real drop (not just a
  // normal off-night) to be flagged. The absolute floor stays fixed — a
  // genuinely short night is worth a nudge regardless of how variable you are.
  if (sleep) {
    const effDeficit =
      sleep.baselineSpreadMin != null && sleep.baselineSpreadMin > 0
        ? Math.max(
            th.sleepDeficitMin,
            th.variabilitySpreadMultiplier * sleep.baselineSpreadMin
          )
        : th.sleepDeficitMin;
    const belowBaseline =
      sleep.baselineMin > 0 &&
      sleep.lastNightMin <= sleep.baselineMin - effDeficit;
    const belowFloor = sleep.lastNightMin < th.sleepFloorMin;
    if (belowBaseline || belowFloor) {
      const detail = belowBaseline
        ? `You slept ${hoursText(sleep.lastNightMin)} last night, below your ~${hoursText(
            sleep.baselineMin
          )} average — consider a rest or light day.`
        : `You slept ${hoursText(sleep.lastNightMin)} last night — consider a rest or light day to recover.`;
      return {
        id: "rest-sleep",
        kind: "rest",
        title: "Rest or take it easy today",
        detail,
        tone: "caution",
      };
    }
  }

  // Elevated resting HR — only when data exists. Same variance-aware widening:
  // with a known personal spread, the jump must clear max(fixed, multiplier ×
  // spread) before it reads as under-recovered.
  const effRhrJump =
    restingHr &&
    restingHr.baselineSpreadBpm != null &&
    restingHr.baselineSpreadBpm > 0
      ? Math.max(
          th.restingHrJumpBpm,
          th.variabilitySpreadMultiplier * restingHr.baselineSpreadBpm
        )
      : th.restingHrJumpBpm;
  if (
    restingHr &&
    restingHr.baseline > 0 &&
    restingHr.recent >= restingHr.baseline + effRhrJump
  ) {
    return {
      id: "rest-rhr",
      kind: "rest",
      title: "Rest or take it easy today",
      detail: `Your resting heart rate is ${Math.round(
        restingHr.recent
      )} bpm, up from your ~${Math.round(
        restingHr.baseline
      )} bpm baseline — an easier day will help you recover.`,
      tone: "caution",
    };
  }

  // Overtraining — consecutive days, or a heavy trailing window. Uses the SAME
  // currentStreak the dashboard StreakWidget shows, so the rest nudge can't drift
  // from the streak the user sees (issue #222).
  const streak = currentStreak(today, trainingDates);
  if (streak >= th.overtrainingConsecutiveDays) {
    return {
      id: "rest-overtraining",
      kind: "rest",
      title: "Rest or take it easy today",
      detail: `You've trained ${streak} days in a row — a rest or light day will help you recover and keep progressing.`,
      tone: "caution",
    };
  }
  const active = activeDaysInWindow(
    trainingDates,
    today,
    th.overtrainingWindowDays
  );
  if (active >= th.overtrainingWindowActiveDays) {
    return {
      id: "rest-load",
      kind: "rest",
      title: "Rest or take it easy today",
      detail: `You've trained ${active} of the last ${th.overtrainingWindowDays} days — consider a rest or light day.`,
      tone: "caution",
    };
  }
  return null;
}

// ---- Rest-episode continuity (#44 item 3b) ----
//
// A rest nudge that fires several days running should read as one continuing
// easy stretch ("second easy day"), not a fresh alarm each morning. That needs a
// tiny bit of memory — the persisted RestEpisode — reconciled the same way the
// refill nudge dedups a low-supply episode: a rest rec (re)marks it, a day with
// no rest rec clears it. These pure functions own the state machine and the
// phrasing; the DB read/write lives in lib/queries/coaching.ts + the notify tick.

// The episode to persist given the prior one and today's rest recommendation (or
// null). An episode CONTINUES when a rest rec fires today and the prior episode
// was last seen today (idempotent re-run) or yesterday (consecutive day); a rest
// rec after a gap (or with no prior episode) OPENS a fresh one; no rest rec today
// CLEARS it (returns null). Pure — callers persist the result.
export function nextRestEpisode(
  prev: RestEpisode | null,
  rec: Recommendation | null,
  today: string
): RestEpisode | null {
  if (!rec || rec.kind !== "rest") return null;
  const yesterday = shiftDateStr(today, -1);
  const continues =
    prev != null && (prev.lastDate === today || prev.lastDate === yesterday);
  return {
    startDate: continues ? prev.startDate : today,
    lastDate: today,
    reasonId: rec.id,
  };
}

// The 1-based day number of an episode as of `today` (start day = 1). Clamped to
// at least 1 so a marker with a future/garbled start never reads as day 0.
export function restEpisodeDay(ep: RestEpisode, today: string): number {
  return Math.max(1, daysSince(ep.startDate, today) + 1);
}

// Small ordinal words for the continuity phrasing; falls back to "Nth" past the
// table, which realistically never shows (an easy stretch this long is rare).
const ORDINAL_WORDS = [
  "zeroth",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

function ordinalWord(n: number): string {
  return ORDINAL_WORDS[n] ?? `${n}th`;
}

// Re-phrase a rest recommendation as day N (N ≥ 2) of a continuing easy stretch:
// the title names the day ("Second easy day") instead of a fresh "Rest or take it
// easy today", and the underlying reason is kept but tagged as ongoing so it no
// longer reads as a new alert. id/kind/tone are preserved, so snooze dedup and
// the caution styling are unchanged.
export function withRestContinuity(
  rec: Recommendation,
  day: number
): Recommendation {
  const word = ordinalWord(day);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  return {
    ...rec,
    title: `${Word} easy day`,
    detail: `${rec.detail} This is your ${word} easy day in a row — keep it light and let recovery catch up.`,
  };
}

// A strength recommendation seeded off an exercise's next-set suggestion. Title
// is the exercise; `target` carries the next-set text; detail leads with the
// progression rationale, then the routine/last-trained reason. `focus`/`exercises`
// carry the shared next-workout suggestion through for the Telegram surface (#221).
function strengthExerciseRec(
  exercise: StrengthRecent,
  wu: WeightUnit,
  reason: string,
  focus: MuscleRegion[] = [],
  exercises: string[] = []
): Recommendation {
  const nextSet = suggestNextSet(exercise, wu);
  return {
    id: `strength-${exercise.exercise}`,
    kind: "strength",
    title: `Train ${exercise.exercise}`,
    detail: nextSet ? `${nextSet.rationale}. ${reason}` : reason,
    tone: "action",
    actionHref: `/training?tab=analyze&kind=strength&item=${encodeURIComponent(
      exercise.exercise
    )}`,
    actionLabel: "View details",
    ...(nextSet ? { target: nextSetText(nextSet, wu) } : {}),
    ...(focus.length ? { focus } : {}),
    ...(exercises.length ? { exercises } : {}),
  };
}

const ON_TRACK: Recommendation = {
  id: "ontrack",
  kind: "ontrack",
  title: "You're on track",
  detail:
    "You've hit your weekly routine — an easy session or a rest day are both fine.",
  tone: "positive",
};

const EMPTY_STATE: Recommendation = {
  id: "setup-empty",
  kind: "setup",
  title: "Start tracking to get coaching",
  detail:
    "Log an activity or set a weekly routine and you'll get a focused suggestion here each day.",
  tone: "neutral",
  actionHref: "/training",
  actionLabel: "Log activity",
};

// The intensity-distribution nudge (issue #159): when the trailing easy/hard split
// drifts hard-heavy — too little easy Zone 2, the classic self-coached failure —
// suggest swapping a hard day for easy aerobic work. Caution-toned, informational
// (never a "go train harder" push). Null unless the split is meaningfully
// hard-heavy over enough volume (classifyPolarization).
export function intensityRecommendation(
  split: PolarizedSplit | null | undefined
): Recommendation | null {
  if (!split) return null;
  if (classifyPolarization(split) !== "hard-heavy") return null;
  return {
    id: "intensity-hard-heavy",
    kind: "intensity",
    title: "Ease off — add easy Zone 2",
    detail: `${split.hardPct}% of your recent training time was hard (above the aerobic threshold); a polarized 80/20 base keeps most of it easy. Swap a hard session for easy Zone 2 to build aerobic volume without the fatigue.`,
    tone: "caution",
    actionHref: "/trends?tab=fitness&ftab=cardio",
    actionLabel: "See HR zones",
  };
}

// Rank a day's recommendations, highest-priority first. The first element is the
// "one clear thing"; any remainder are secondary context.
export function recommendCoaching(input: CoachingInput): Recommendation[] {
  const th = { ...DEFAULT_COACHING_THRESHOLDS, ...(input.thresholds ?? {}) };
  const wu = input.weightUnit ?? "kg";
  const { routine, strength, cardio } = input;

  const hasContext =
    input.trainingDates.length > 0 ||
    strength.length > 0 ||
    cardio.length > 0 ||
    routine.length > 0;
  // No data at all → a single friendly empty state.
  if (!hasContext) return [EMPTY_STATE];

  // A recovery signal (rest) presupposes a training context, so it's evaluated
  // only here — and it takes precedence over any "go train" nudge below.
  const rest = restRecommendation(input, th);

  // Build the training-side recommendations (cardio gap, strength gap, on-track,
  // or a habit-based/setup fallback).
  const training = trainingRecommendations(input, wu);

  // A hard-heavy intensity distribution is context, not a top-line alert: it rides
  // along as a trailing secondary note (classifyPolarization is the gate).
  const intensity = intensityRecommendation(input.intensity);

  const ranked: Recommendation[] = [];
  if (rest) {
    // Episode continuity (#44 item 3b): if this rest run continues a prior one,
    // phrase it as "second/third easy day" rather than a fresh alert. Derived
    // purely from the persisted marker + today, so it's robust even if the marker
    // hasn't been advanced yet today (the notify tick owns the write).
    const episode = nextRestEpisode(
      input.restEpisode ?? null,
      rest,
      input.today
    );
    const day = episode ? restEpisodeDay(episode, input.today) : 1;
    ranked.push(day >= 2 ? withRestContinuity(rest, day) : rest);
    // Keep the "what to do once recovered" nudge as secondary context, but drop
    // a redundant on-track note (rest already implies rest is fine).
    for (const r of training) if (r.kind !== "ontrack") ranked.push(r);
    if (intensity) ranked.push(intensity);
    return ranked;
  }
  if (intensity) return [...training, intensity];
  return training;
}

// The non-rest, training-side recommendations in priority order. Now a pure
// FORMATTER over the unified next-workout core (#221): the core decides WHAT to
// train (routine-gap composition, #185 practiced-activity picker, recovery
// exclusion, weekday habit, on-track/setup) and this maps each ranked item to a
// Recommendation card. The Telegram reminder formats the same core result, so the
// two surfaces can no longer disagree.
function trainingRecommendations(
  input: CoachingInput,
  wu: WeightUnit
): Recommendation[] {
  const nw = recommendNextWorkout(input);
  return nw.items.map((item) => formatWorkoutItem(item, nw, input.today, wu));
}

// Map one core NextWorkoutItem to its Recommendation card, preserving the exact
// per-branch copy each dashboard/overview surface renders.
function formatWorkoutItem(
  item: NextWorkoutItem,
  nw: NextWorkout,
  today: string,
  wu: WeightUnit
): Recommendation {
  if (item.kind === "cardio") {
    if (item.reason === "routine-gap") {
      const t = item.target!;
      const remaining = Math.max(0, t.perWeek - t.count);
      const suggestion = item.activity;
      return {
        id: "cardio-gap",
        kind: "cardio",
        title: "Add a cardio session",
        detail: `${t.count} of ${t.perWeek} cardio ${pluralSessions(
          t.perWeek
        )} this week — ${remaining} to go.${
          suggestion
            ? ` ${suggestion.activity} — last done ${formatRelativeDate(
                suggestion.lastDate,
                today
              )}.`
            : ""
        }`,
        tone: "action",
        actionHref: suggestion
          ? `/training?tab=analyze&kind=cardio&item=${encodeURIComponent(
              suggestion.activity
            )}`
          : "/training",
        actionLabel: suggestion ? "View details" : "Log activity",
      };
    }
    // Habit-based cardio (no routine): the picked activity is guaranteed present.
    const a = item.activity!;
    return {
      id: `cardio-${a.activity}`,
      kind: "cardio",
      title: `Add a ${a.activity} session`,
      detail: `Last done ${formatRelativeDate(a.lastDate, today)}.`,
      tone: "action",
      actionHref: `/training?tab=analyze&kind=cardio&item=${encodeURIComponent(
        a.activity
      )}`,
      actionLabel: "View details",
    };
  }

  if (item.kind === "strength") {
    if (item.reason === "routine-gap") {
      const t = item.target!;
      const label = frequencyScopeLabel(t.scopeKind, t.scopeValue);
      const remaining = Math.max(0, t.perWeek - t.count);
      const reason = `${t.count} of ${t.perWeek} ${label} ${pluralSessions(
        t.perWeek
      )} this week — ${remaining} to go.`;
      return item.exercise
        ? strengthExerciseRec(item.exercise, wu, reason, nw.focus, nw.exercises)
        : {
            id: `strength-${label}`,
            kind: "strength",
            title: `Train ${label}`,
            detail: reason,
            tone: "action",
            actionHref: "/training",
            actionLabel: "Log activity",
          };
    }
    // Habit-based strength (no routine): the picked exercise is guaranteed present.
    return strengthExerciseRec(
      item.exercise!,
      wu,
      `Last trained ${formatRelativeDate(item.exercise!.lastDate, today)}.`,
      nw.focus,
      nw.exercises
    );
  }

  if (item.kind === "ontrack") {
    return item.reason === "trained-today"
      ? {
          id: "ontrack-today",
          kind: "ontrack",
          title: "Nice work today",
          detail:
            "You already logged training today — resting or an easy session is fine now.",
          tone: "positive",
        }
      : ON_TRACK;
  }

  // Setup / empty state.
  return EMPTY_STATE;
}
