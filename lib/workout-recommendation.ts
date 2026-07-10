// Unified "what workout should you do next" computation (#221).
//
// Historically two independent engines answered this question and drifted apart:
// the Telegram nudge (lib/notifications/recommend.ts — bounded window, recovery
// exclusion, weekday habit, exercise list) and the dashboard/overview coaching
// engine (lib/coaching.ts — all-time aggregates, routine-gap driven). Same
// morning they could disagree by construction. This module is the ONE pure core
// both surfaces now consume; each surface only formats the result (Telegram copy
// vs the CoachingWidget/Training-overview Recommendation cards).
//
// The core folds together the strongest parts of both: the Telegram engine's
// bounded window + recovery exclusion + weekday habit + frequency-ranked exercise
// list, and the coaching engine's routine-gap composition, #185-fixed
// practiced-activity picker, and on-track/setup states. Rest/recovery overrides
// and the intensity nudge stay in lib/coaching (they are not "what to train"
// decisions) and continue to wrap this result.
//
// Pure and client-safe — no DB/network — so it runs in components and under test.
import {
  regionForExercise,
  regionsForGroup,
  LIFT_OPTIONS,
  type MuscleRegion,
  type BodyGroup,
} from "./lifts";
import { weekdayOfDateStr, shiftDateStr } from "./date";
import type {
  StrengthRecent,
  CardioRecent,
  RoutineTargetProgress,
} from "./coaching";

// ---- Windows ----

// The "least-recently-done" variety nudge only makes sense among activities you
// actually train now. Bound it to this trailing window (days) so an ancient
// one-off — an imported 2015 kayak, a single lift logged years ago — can't
// permanently win the least-recent slot and read as "your last cardio was 11
// years ago" (#185). A quarter is generous enough to keep genuine variety
// (a biweekly cross-train, a monthly long ride) while excluding stale history.
export const VARIETY_LOOKBACK_DAYS = 90;

// The dated-history window the focus/exercise heuristics scan (recovery
// exclusion, weekday habit, frequency ranking). Matches the Telegram engine's
// original 56-day bound — long enough for a stable weekday pattern, short enough
// that a stale phase doesn't skew the ranking.
export const WORKOUT_LOOKBACK_DAYS = 56;

// ---- Shared date helpers (pure, self-contained) ----

// Whole days from an ISO date to `today` (both YYYY-MM-DD), or Infinity if
// unparseable.
function daysBetween(dateISO: string, today: string): number {
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}

function within(dateISO: string, today: string, days: number): boolean {
  const d = daysBetween(dateISO, today);
  return d >= 0 && d <= days;
}

// ---- Inputs / outputs ----

// One (date, exercise) row over the recent window — the raw material for the
// recovery-exclusion, weekday-habit, and frequency-ranking heuristics. Absent
// from the input ⇒ the core degrades to aggregate-only picks (the previous
// coaching behavior), so callers without dated history still get a suggestion.
export interface DatedExercise {
  date: string; // YYYY-MM-DD
  exercise: string;
}

// The slice of a behind weekly target the core carries forward so each surface
// can render its own copy without re-deriving the numbers.
export interface BehindTarget {
  // The frequency_targets row id — the identity the Upcoming `training:<id>` finding
  // is keyed on (#245). Carried through so the workout nudge can derive the SAME
  // `trainingSignalKey(id)` and be silenced when that finding is dismissed/snoozed.
  // Null only when the caller's target has no id (test fixtures); production always
  // supplies it.
  id: number | null;
  scopeKind: string; // 'type' | 'region' | 'group'
  scopeValue: string;
  count: number;
  perWeek: number;
}

export interface NextWorkoutInput {
  today: string; // profile-tz YYYY-MM-DD
  routine: RoutineTargetProgress[];
  strength: StrengthRecent[];
  cardio: CardioRecent[];
  // Bounded-window dated exercise rows; enables recovery exclusion + weekday
  // habit + frequency-ranked exercise lists. Optional — see DatedExercise.
  datedExercises?: DatedExercise[];
}

// How a workout item was arrived at, so a formatter can phrase it precisely:
//   routine-gap   — behind a weekly target
//   routine-met   — every weekly target is satisfied
//   trained-today — already logged training today (no routine)
//   habit         — no routine; least-recently-done activity
//   empty         — no usable history at all
export type NextWorkoutReason =
  "routine-gap" | "routine-met" | "trained-today" | "habit" | "empty";

export type NextWorkoutKind = "strength" | "cardio" | "ontrack" | "setup";

// One ranked workout recommendation. items[0] is "the one clear thing"; a
// routine behind on both cardio and strength yields two (cardio first).
export interface NextWorkoutItem {
  kind: NextWorkoutKind;
  reason: NextWorkoutReason;
  // The lead lift for a strength item — carries lastSessionBest so a formatter
  // can seed next-set progression. Null ⇒ a generic "train this scope" nudge.
  exercise: StrengthRecent | null;
  // The picked activity for a cardio item. Null ⇒ a generic "log a cardio" nudge.
  activity: CardioRecent | null;
  // The behind weekly target that drove a routine-gap item (null otherwise).
  target: BehindTarget | null;
}

export interface NextWorkout {
  items: NextWorkoutItem[];
  // The shared strength-workout suggestion, used by every surface: the focus
  // regions to emphasize and a ranked exercise list. Computed once, scoped to a
  // behind strength target when one exists, so Telegram and the dashboard agree.
  focus: MuscleRegion[];
  exercises: string[];
  // The lead strength exercise the focus/exercises resolve to (== exercises[0]'s
  // aggregate row), for the next-set card. Null when the lead came from the
  // catalog (never trained) or there's no strength suggestion.
  primary: StrengthRecent | null;
  // Every behind weekly target, for surfaces that list "behind this week" context.
  behind: BehindTarget[];
}

// ---- Target helpers ----

function isCardioTarget(t: RoutineTargetProgress): boolean {
  return t.target.scope_kind === "type" && t.target.scope_value === "cardio";
}

// Least-complete first (fraction of the weekly target met), so the most-overdue
// target leads. Stable tie-break keeps output deterministic.
function byFractionComplete(
  a: RoutineTargetProgress,
  b: RoutineTargetProgress
): number {
  const fa = a.count / Math.max(1, a.per_week);
  const fb = b.count / Math.max(1, b.per_week);
  if (fa !== fb) return fa - fb;
  return a.target.scope_value.localeCompare(b.target.scope_value);
}

function toBehindTarget(t: RoutineTargetProgress): BehindTarget {
  return {
    id: t.target.id ?? null,
    scopeKind: t.target.scope_kind,
    scopeValue: t.target.scope_value,
    count: t.count,
    perWeek: t.per_week,
  };
}

// The regions a behind region/group target maps onto (a type target contributes
// none — it surfaces as a label, not a region focus).
function regionsForTarget(t: RoutineTargetProgress): MuscleRegion[] {
  if (t.target.scope_kind === "region")
    return [t.target.scope_value as MuscleRegion];
  if (t.target.scope_kind === "group")
    return regionsForGroup(t.target.scope_value as BodyGroup);
  return [];
}

// The candidate regions a strength suggestion may draw from, given the behind
// strength target it's scoped to. Null ⇒ unscoped (any region), used for a
// type=strength target and for the no-routine habit path.
function candidateRegions(
  scopeTarget: RoutineTargetProgress | null
): Set<MuscleRegion> | null {
  if (!scopeTarget) return null;
  const regions = regionsForTarget(scopeTarget);
  return regions.length > 0 ? new Set(regions) : null;
}

// ---- Practiced-activity pickers (#185: bounded to the variety window) ----

// The least-recently-done cardio activity within the variety lookback (an
// ancient one-off is excluded, not treated as a lapsed habit). Stable tie-break
// by name. Null when nothing qualifies.
export function pickOldestCardio(
  cardio: CardioRecent[],
  today: string
): CardioRecent | null {
  return (
    [...cardio]
      .filter((c) => within(c.lastDate, today, VARIETY_LOOKBACK_DAYS))
      .sort((a, b) =>
        a.lastDate === b.lastDate
          ? a.activity.localeCompare(b.activity)
          : a.lastDate.localeCompare(b.lastDate)
      )[0] ?? null
  );
}

// Newest training date across strength + cardio, or undefined.
function latestTrainingDate(
  strength: StrengthRecent[],
  cardio: CardioRecent[]
): string | undefined {
  return [...strength.map((s) => s.lastDate), ...cardio.map((c) => c.lastDate)]
    .filter(Boolean)
    .sort()
    .at(-1);
}

// ---- The shared strength-workout computation ----

// Compute the focus regions + ranked exercise list + lead exercise for a strength
// suggestion, scoped to `scopeTarget` when set. Two data paths, one decision:
//   • With dated history: recovery exclusion (skip yesterday's regions), weekday
//     habit (regions usually trained on today's weekday), behind-target ordering,
//     and a frequency-ranked exercise list — the Telegram engine's heuristics.
//   • Without dated history: fall back to the least-recently-trained qualifying
//     aggregate rows (the previous coaching behavior), so callers with only
//     per-exercise stats still get a stable pick.
function computeStrengthWorkout(
  input: NextWorkoutInput,
  scopeTarget: RoutineTargetProgress | null
): {
  focus: MuscleRegion[];
  exercises: string[];
  primary: StrengthRecent | null;
} {
  const { today, strength, routine } = input;
  const candidate = candidateRegions(scopeTarget);

  // Regions the routine is behind on, for focus ordering (behind ∩ usual first).
  const behindRegions: MuscleRegion[] = [];
  for (const t of routine)
    if (!t.met) for (const r of regionsForTarget(t)) behindRegions.push(r);

  const dated = (input.datedExercises ?? []).filter((r) =>
    within(r.date, today, WORKOUT_LOOKBACK_DAYS)
  );

  if (dated.length > 0) {
    const inScope = (r: MuscleRegion) => candidate == null || candidate.has(r);
    const focusRegions = focusFromHistory(dated, today, behindRegions, inScope);
    const exercises = rankExercises(dated, focusRegions);
    const primary = strength.find((s) => s.exercise === exercises[0]) ?? null;
    return { focus: focusRegions, exercises, primary };
  }

  // Aggregate fallback: qualifying strength rows within the variety window,
  // scoped to the target, least-recently-trained first (stable by name).
  const qualifying = strength
    .filter((s) => within(s.lastDate, today, VARIETY_LOOKBACK_DAYS))
    .filter((s) => {
      const r = regionForExercise(s.exercise);
      return candidate == null ? true : r != null && candidate.has(r);
    })
    .sort((a, b) =>
      a.lastDate === b.lastDate
        ? a.exercise.localeCompare(b.exercise)
        : a.lastDate.localeCompare(b.lastDate)
    );

  const focus: MuscleRegion[] = [];
  for (const s of qualifying) {
    const r = regionForExercise(s.exercise);
    if (r && !focus.includes(r)) focus.push(r);
  }
  return {
    focus: focus.slice(0, 3),
    exercises: qualifying.map((s) => s.exercise).slice(0, 5),
    primary: qualifying[0] ?? null,
  };
}

// Focus regions from dated history: behind ∩ usual, then behind, then usual —
// each excluding regions trained yesterday (recovery) and out-of-scope regions;
// falling back to the least-recently-trained in-scope regions when nothing
// matched. Up to three regions.
function focusFromHistory(
  rows: DatedExercise[],
  today: string,
  behindRegions: MuscleRegion[],
  inScope: (r: MuscleRegion) => boolean
): MuscleRegion[] {
  const yesterday = shiftDateStr(today, -1);
  const todayWeekday = weekdayOfDateStr(today);

  // Regions trained yesterday → excluded today (recovery).
  const excluded = new Set<MuscleRegion>();
  for (const r of rows) {
    if (r.date !== yesterday) continue;
    const reg = regionForExercise(r.exercise);
    if (reg) excluded.add(reg);
  }

  // Regions usually trained on this weekday (habitual = ≥2 distinct such dates).
  const wdRegionDates = new Map<MuscleRegion, Set<string>>();
  for (const r of rows) {
    if (weekdayOfDateStr(r.date) !== todayWeekday) continue;
    const reg = regionForExercise(r.exercise);
    if (!reg) continue;
    let s = wdRegionDates.get(reg);
    if (!s) wdRegionDates.set(reg, (s = new Set()));
    s.add(r.date);
  }
  const usualRegions = [...wdRegionDates.entries()]
    .filter(([, d]) => d.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([reg]) => reg);

  const focus: MuscleRegion[] = [];
  const add = (r: MuscleRegion) => {
    if (!excluded.has(r) && inScope(r) && !focus.includes(r)) focus.push(r);
  };
  for (const r of usualRegions) if (behindRegions.includes(r)) add(r);
  for (const r of behindRegions) add(r);
  for (const r of usualRegions) add(r);

  // Fallback: the least-recently-trained in-scope regions (overdue) not done
  // yesterday. Only regions with history — never-trained ones have no exercises.
  if (focus.length === 0) {
    const lastByRegion = new Map<MuscleRegion, string>();
    for (const r of rows) {
      const reg = regionForExercise(r.exercise);
      if (!reg) continue;
      const cur = lastByRegion.get(reg);
      if (!cur || r.date > cur) lastByRegion.set(reg, r.date);
    }
    [...lastByRegion.entries()]
      .filter(([r]) => !excluded.has(r) && inScope(r))
      .sort((a, b) => a[1].localeCompare(b[1])) // oldest last-trained first
      .slice(0, 2)
      .forEach(([r]) => add(r));
  }

  return focus.slice(0, 3);
}

// A ranked exercise list across the focus regions: per region, exercises ranked
// by recent frequency; round-robin across regions up to five, with a catalog
// fallback for a focus region that has no logged history.
function rankExercises(
  rows: DatedExercise[],
  focusRegions: MuscleRegion[]
): string[] {
  const exCount = new Map<string, number>();
  for (const r of rows)
    exCount.set(r.exercise, (exCount.get(r.exercise) ?? 0) + 1);

  const perRegion = new Map<MuscleRegion, string[]>();
  for (const reg of focusRegions) perRegion.set(reg, []);
  for (const [ex] of [...exCount.entries()].sort((a, b) => b[1] - a[1])) {
    const reg = regionForExercise(ex);
    if (reg && perRegion.has(reg) && !perRegion.get(reg)!.includes(ex))
      perRegion.get(reg)!.push(ex);
  }
  // Catalog fallback for a focus region with no logged history.
  for (const reg of focusRegions) {
    if (perRegion.get(reg)!.length === 0) {
      const cat = LIFT_OPTIONS.find((n) => regionForExercise(n) === reg);
      if (cat) perRegion.get(reg)!.push(cat);
    }
  }

  const exercises: string[] = [];
  for (let i = 0; exercises.length < 5; i++) {
    let added = false;
    for (const reg of focusRegions) {
      const pick = perRegion.get(reg)![i];
      if (pick) {
        exercises.push(pick);
        added = true;
        if (exercises.length >= 5) break;
      }
    }
    if (!added) break;
  }
  return exercises;
}

// ---- The unified core ----

// Rank the day's workout items and compute the shared focus/exercise suggestion.
// The result is surface-agnostic; lib/coaching formats it into Recommendation
// cards (wrapping it with rest/intensity) and lib/notifications formats it into
// the Telegram reminder. Rest/recovery is intentionally NOT decided here.
export function recommendNextWorkout(input: NextWorkoutInput): NextWorkout {
  const { routine, strength, cardio, today } = input;

  const behind = routine.filter((t) => !t.met);
  const behindTargets = behind.map(toBehindTarget);

  // Scope the shared strength suggestion to the most-overdue behind strength
  // target when the routine has one; otherwise leave it unscoped (habit).
  const behindStrength = behind
    .filter((t) => !isCardioTarget(t))
    .sort(byFractionComplete)[0];
  const { focus, exercises, primary } = computeStrengthWorkout(
    input,
    behindStrength ?? null
  );

  const base = { focus, exercises, primary, behind: behindTargets };
  const items: NextWorkoutItem[] = [];

  if (routine.length > 0) {
    const behindCardio = behind
      .filter(isCardioTarget)
      .sort(byFractionComplete)[0];
    if (behindCardio) {
      items.push({
        kind: "cardio",
        reason: "routine-gap",
        exercise: null,
        activity: pickOldestCardio(cardio, today),
        target: toBehindTarget(behindCardio),
      });
    }
    if (behindStrength) {
      items.push({
        kind: "strength",
        reason: "routine-gap",
        exercise: primary,
        activity: null,
        target: toBehindTarget(behindStrength),
      });
    }
    if (items.length === 0) {
      // Every target met.
      items.push({
        kind: "ontrack",
        reason: "routine-met",
        exercise: null,
        activity: null,
        target: null,
      });
    }
    return { items, ...base };
  }

  // No weekly routine: a habit-based next workout.
  if (latestTrainingDate(strength, cardio) === today) {
    items.push({
      kind: "ontrack",
      reason: "trained-today",
      exercise: null,
      activity: null,
      target: null,
    });
    return { items, ...base };
  }
  if (primary) {
    items.push({
      kind: "strength",
      reason: "habit",
      exercise: primary,
      activity: null,
      target: null,
    });
    return { items, ...base };
  }
  const activity = pickOldestCardio(cardio, today);
  if (activity) {
    items.push({
      kind: "cardio",
      reason: "habit",
      exercise: null,
      activity,
      target: null,
    });
    return { items, ...base };
  }
  items.push({
    kind: "setup",
    reason: "empty",
    exercise: null,
    activity: null,
    target: null,
  });
  return { items, ...base };
}
