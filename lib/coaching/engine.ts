// Rule-based coaching engine: the deterministic "one clear thing to do today"
// recommender. Pure and client-safe — no DB/network.
import { frequencyScopeLabel } from "../goals";
import { formatRelativeDate } from "../format-date";
import { shiftDateStr } from "../date";
import { currentStreak } from "../streak";
import { classifyPolarization, type PolarizedSplit } from "../training-zones";
import {
  recommendNextWorkout,
  type DatedExercise,
  type NextWorkout,
  type NextWorkoutItem,
} from "../workout-recommendation";
import type { EquipmentAvailability } from "../equipment-availability";
import type { WeightUnit } from "../settings";
import type { AppRoute } from "../hrefs";
import type { MuscleRegion } from "../lifts";
import { suggestNextSet, nextSetText, type NextSetSeed } from "./strength";

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
  actionHref?: AppRoute;
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
    // The frequency_targets row id. Optional in the type (test fixtures omit it),
    // always present in production (FrequencyTargetProgress supplies it) — it's the
    // identity the Upcoming `training:<id>` finding and the workout nudge line up on
    // (#245), so the shared signal key can silence the push when the finding is
    // dismissed.
    id?: number;
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
  // The profile's equipment availability (issue #345), threaded through the ONE
  // coaching gather so BOTH the dashboard/overview cards and the Telegram workout
  // nudge prefer gear-satisfiable "train today" content by construction. Optional —
  // absent ⇒ no equipment gating (the prior behavior).
  availableEquipment?: EquipmentAvailability;
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
