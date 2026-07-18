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
  exerciseHistoryKey,
  LIFT_OPTIONS,
  type MuscleRegion,
  type BodyGroup,
} from "./lifts";
import { weekdayOfDateStr, shiftDateStr } from "./date";
import {
  deRankUnavailableLifts,
  type EquipmentAvailability,
} from "./equipment-availability";
import {
  excludedRegions as computeExcludedRegions,
  temperedRegions as computeTemperedRegions,
  excludedRegionDisclosures,
  type InjuryConstraint,
  type ExcludedRegionDisclosure,
} from "./injury-model";
import type { ConditionConsideration } from "./condition-training-considerations";
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
  // The profile's equipment availability (issue #345). When present and non-empty,
  // the shared strength suggestion PREFERS lifts satisfiable with available gear —
  // a dumbbell-only home-gym user's "train today" leads with a lift they can do.
  // Absent / empty registry ⇒ no gating (gym-goers own no rows), so every existing
  // caller/test keeps its prior ordering.
  availableEquipment?: EquipmentAvailability;
  // The profile's ACTIVE routine (#740), when one exists. Present ⇒ the core
  // resolves TODAY'S routine day into a filled session (the authoritative
  // recommendation every surface renders). Absent / null ⇒ the routine path is
  // never entered and the result is byte-for-byte the prior no-routine behavior.
  // RoutineWithDays (lib/routines) structurally satisfies this minimal shape.
  activeRoutine?: ActiveRoutineInput | null;
  // Whether the active routine's mesocycle says TODAY is a deload week (#741),
  // resolved once by the DB gather getRoutineCycleStatus and passed in — the flag
  // every surface reads (one gather, not per surface). Carried onto the resolved
  // RoutineSession so the recommendation formatters phrase the deload and apply
  // deloadAdjust. Absent / false ⇒ byte-for-byte the non-deload behavior.
  deloadWeek?: boolean;
  // User-declared injury constraints (#838), NON-resolved only. ACTIVE injury regions
  // are EXCLUDED from the focus/exercise suggestion and the behind-target (routine-gap)
  // set — always DISCLOSED via `excludedRegions` below, never silent. RECOVERING regions
  // return but are TEMPERED (surfaces back off the target via RECOVERING_LOAD_FACTOR).
  // The exclusion is the user's own constraint (equipment-availability class of #666's
  // taxonomy), so re-ranking IS permitted here. Absent / empty ⇒ no exclusion.
  injuries?: InjuryConstraint[];
  // Curated condition→training CONSIDERATION notes (#666) for the profile's ACTIVE mapped
  // conditions. These ride ALONGSIDE the unchanged recommendation — they NEVER gate or
  // re-rank (medical judgment stays with the clinician). Passed straight through to
  // `considerations` on the result so every surface renders the same calm note. Absent /
  // empty ⇒ nothing.
  considerations?: ConditionConsideration[];
}

// The slice of the active routine the core reads to resolve today's session — a
// structural subset of RoutineWithDays so `getActiveRoutine(profileId)` passes
// straight through, while the pure core stays decoupled from the DB row type.
export interface ActiveRoutineInput {
  id: number;
  // Rotation cursor into `days`; advanced by session crediting (#740). Resolved
  // modulo the day count, so it never runs off the end of the sequence.
  position: number;
  days: {
    id: number;
    label: string;
    focus: MuscleRegion[];
    slots: {
      candidates: string[];
      sets: number;
      rep_min: number;
      rep_max: number;
    }[];
  }[];
}

// One filled slot of today's resolved routine session: the candidate the user can
// actually do (equipment-de-ranked first choice), its prescription, and the
// next-set seed for a concrete load target (null ⇒ cold start / never trained,
// so the surface shows sets × rep range with NO load).
export interface RoutineSessionSlot {
  exercise: string;
  candidates: string[];
  sets: number;
  repMin: number;
  repMax: number;
  seed: StrengthRecent | null;
}

// Today's resolved routine day as a complete, fillable session (#740). Produced
// only when an active routine exists; every surface (dashboard, Training
// overview, Telegram nudge, "Log this session" prefill) renders THIS one result.
export interface RoutineSession {
  routineId: number;
  dayId: number;
  label: string; // the day's label, e.g. "Push"
  focus: MuscleRegion[];
  // A cardio-focus day (empty `focus`) vs a strength day — the crediting rule and
  // the surface copy both key on this.
  kind: "strength" | "cardio";
  slots: RoutineSessionSlot[];
  // TODAY is the routine's deload week (#741) — the last week of its mesocycle.
  // Set from NextWorkoutInput.deloadWeek (the one gather). When true the surfaces
  // phrase "Deload week" and run the slates through deloadAdjust; false ⇒ the
  // ordinary session, unchanged.
  deloadWeek: boolean;
}

// How a workout item was arrived at, so a formatter can phrase it precisely:
//   routine-gap   — behind a weekly target
//   routine-met   — every weekly target is satisfied
//   trained-today — already logged training today (no routine)
//   habit         — no routine; least-recently-done activity
//   routine-day   — an active routine resolved TODAY'S day into a filled session
//   empty         — no usable history at all
export type NextWorkoutReason =
  | "routine-gap"
  | "routine-met"
  | "trained-today"
  | "habit"
  | "routine-day"
  | "empty";

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
  // Today's resolved routine session (#740) when an active routine exists; null
  // otherwise. When set, `focus`/`exercises`/`primary` above are DERIVED from this
  // session, so every surface renders the routine day by construction.
  session: RoutineSession | null;
  // Regions EXCLUDED from this recommendation by an ACTIVE injury (#838), each with the
  // responsible injury labels — so the exclusion is NEVER silent ("avoiding Chest (right
  // shoulder injury)"). Empty when no active injury. Every surface renders this
  // disclosure alongside the (unchanged in shape) suggestion.
  excludedRegions: ExcludedRegionDisclosure[];
  // Regions returning at TEMPERED targets because a RECOVERING injury covers them (#838).
  // A surface backs off the next-set target (RECOVERING_LOAD_FACTOR) and phrases "easing
  // back". Empty when no recovering injury.
  temperedRegions: MuscleRegion[];
  // Whether today's routine day's focus is ENTIRELY within excluded regions (#838): the
  // day can't be trained around the injury, so a surface offers a SUBSTITUTION day rather
  // than marking it missed. Always false when there's no routine session.
  substitutionSuggested: boolean;
  // Curated condition CONSIDERATION notes (#666) riding alongside — informational, never
  // gating. Pass-through of the input; empty when no mapped active condition.
  considerations: ConditionConsideration[];
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

// Whether a behind weekly target is ENTIRELY within active-injury-excluded regions (#838)
// — a region/group target whose every region is off the table. Such a "behind on chest"
// nag is noise while the region is out, so it's dropped from the behind set. A TYPE target
// (cardio/strength) maps to no region and is never excluded here.
function targetFullyExcluded(
  t: RoutineTargetProgress,
  excluded: Set<MuscleRegion>
): boolean {
  const regions = regionsForTarget(t);
  return regions.length > 0 && regions.every((r) => excluded.has(r));
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
  scopeTarget: RoutineTargetProgress | null,
  excluded: Set<MuscleRegion>
): {
  focus: MuscleRegion[];
  exercises: string[];
  primary: StrengthRecent | null;
} {
  const { today, strength, routine } = input;
  const candidate = candidateRegions(scopeTarget);

  // Regions the routine is behind on, for focus ordering (behind ∩ usual first) — an
  // ACTIVE-injury-excluded region is dropped so a "behind on chest" nag can't pull the
  // focus onto an off-limits region (#838).
  const behindRegions: MuscleRegion[] = [];
  for (const t of routine)
    if (!t.met)
      for (const r of regionsForTarget(t))
        if (!excluded.has(r)) behindRegions.push(r);

  const dated = (input.datedExercises ?? []).filter((r) =>
    within(r.date, today, WORKOUT_LOOKBACK_DAYS)
  );

  if (dated.length > 0) {
    // In scope AND not excluded by an active injury (#838) — the exclusion is the user's
    // own constraint, so it re-ranks the focus (unlike a condition, which never gates).
    const inScope = (r: MuscleRegion) =>
      (candidate == null || candidate.has(r)) && !excluded.has(r);
    const focusRegions = focusFromHistory(dated, today, behindRegions, inScope);
    const exercises = rankExercises(dated, focusRegions);
    return withEquipmentPreference(focusRegions, exercises, input);
  }

  // Aggregate fallback: qualifying strength rows within the variety window,
  // scoped to the target, least-recently-trained first (stable by name).
  const qualifying = strength
    .filter((s) => within(s.lastDate, today, VARIETY_LOOKBACK_DAYS))
    .filter((s) => {
      const r = regionForExercise(s.exercise);
      if (r != null && excluded.has(r)) return false; // injury-excluded region (#838)
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
  return withEquipmentPreference(
    focus.slice(0, 3),
    qualifying.map((s) => s.exercise).slice(0, 5),
    input
  );
}

// Apply the #345 equipment preference to a computed strength suggestion: de-rank
// exercises the profile can't do with its available gear (a no-op when the
// registry is empty/absent — see equipment-availability), then re-derive the lead
// lift from the reordered list so `primary` and the exercise list agree. `primary`
// stays a StrengthRecent from the input rows (or null when the lead came from the
// catalog / no strength history).
function withEquipmentPreference(
  focus: MuscleRegion[],
  exercises: string[],
  input: NextWorkoutInput
): {
  focus: MuscleRegion[];
  exercises: string[];
  primary: StrengthRecent | null;
} {
  const ranked = deRankUnavailableLifts(exercises, input.availableEquipment);
  // Match the lead lift to its strength aggregate by CANONICAL identity, not raw
  // spelling (#626/#432): getStrengthByExercise emits one aggregate row per merged
  // lift under its first-seen spelling, while `ranked[0]` is the recent-window
  // frequency-top spelling — a raw `===` misses when the two diverge (logged "Curl"
  // long ago, "Barbell Curl" recently), dropping `primary` to null and losing the
  // progression seed / the whole strength suggestion.
  const lead = ranked[0];
  const key = lead != null ? exerciseHistoryKey(lead) : null;
  const primary =
    key != null
      ? (input.strength.find((s) => exerciseHistoryKey(s.exercise) === key) ??
        null)
      : null;
  return { focus, exercises: ranked, primary };
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
  // Count and dedup by CANONICAL identity (#626/#432): "Curl" and "Barbell Curl"
  // are one merged lift, so they must count as ONE exercise and never both surface
  // in the list. Each key is displayed under its most-recently-logged spelling.
  const exCount = new Map<string, number>();
  const repSpelling = new Map<string, string>();
  const repDate = new Map<string, string>();
  for (const r of rows) {
    const k = exerciseHistoryKey(r.exercise);
    exCount.set(k, (exCount.get(k) ?? 0) + 1);
    const seen = repDate.get(k);
    if (seen == null || r.date >= seen) {
      repDate.set(k, r.date);
      repSpelling.set(k, r.exercise);
    }
  }

  const perRegion = new Map<MuscleRegion, string[]>();
  for (const reg of focusRegions) perRegion.set(reg, []);
  for (const [k] of [...exCount.entries()].sort((a, b) => b[1] - a[1])) {
    const ex = repSpelling.get(k)!;
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

// ---- Routine-aware path (#740) ----

// The rotation cursor → TODAY'S routine day INDEX. ONE computation (#831) shared by
// the recommendation core (resolveRoutineSession, below) and the crediting write
// path (creditRoutineSession, lib/routines.ts) so the day the UI shows as "today"
// and the day a logged session advances the cursor past can never disagree — the
// "one question, one computation" rule (#221/#222/#223). A routine is a SEQUENCE not
// a calendar, so the cursor is read modulo the day count and a possibly-negative or
// overflowed value is normalized into [0, n). Returns null when the routine has no
// days. Pure (index math over a day count) so both call sites are formatters over it.
export function resolveTodayRoutineDayIndex(routine: {
  position: number;
  days: readonly unknown[];
}): number | null {
  const n = routine.days.length;
  if (n === 0) return null;
  return ((routine.position % n) + n) % n;
}

// Resolve TODAY'S routine day from the rotation cursor, filling each slot with the
// first candidate the user can actually do (equipment de-rank — a no-op when the
// registry is empty, so a gym user / cold start gets the first listed candidate)
// and attaching that lift's next-set seed (null ⇒ cold start / never trained).
// The cursor is read modulo the day count — a routine is a SEQUENCE, not a
// calendar, so it never runs off the end. Null when the routine has no days.
export function resolveRoutineSession(
  routine: ActiveRoutineInput,
  input: NextWorkoutInput
): RoutineSession | null {
  const idx = resolveTodayRoutineDayIndex(routine);
  if (idx === null) return null;
  const day = routine.days[idx];
  const isCardioDay = day.focus.length === 0;

  const slots: RoutineSessionSlot[] = day.slots.map((s) => {
    const ranked = deRankUnavailableLifts(
      s.candidates,
      input.availableEquipment
    );
    const exercise = ranked[0] ?? s.candidates[0] ?? "";
    const key = exercise ? exerciseHistoryKey(exercise) : null;
    const seed =
      key != null
        ? (input.strength.find(
            (st) => exerciseHistoryKey(st.exercise) === key
          ) ?? null)
        : null;
    return {
      exercise,
      candidates: s.candidates,
      sets: s.sets,
      repMin: s.rep_min,
      repMax: s.rep_max,
      seed,
    };
  });

  return {
    routineId: routine.id,
    dayId: day.id,
    label: day.label,
    focus: day.focus,
    kind: isCardioDay ? "cardio" : "strength",
    slots,
    deloadWeek: input.deloadWeek ?? false,
  };
}

// Whether a logged session CREDITS a routine day — the load-bearing crediting
// rule (#740), derived ENTIRELY from the logged data (no hidden `routine_day_id`
// link column). The day is a cardio-focus day iff its `focus` is empty.
//   • a strength day is credited iff the session's strength regions (via
//     exerciseHistoryKey → LiftDef.region, gathered by the caller) overlap the
//     day's focus at all — so a pre-filled slate credits by construction and an
//     improvised session that genuinely worked the focus counts too;
//   • a cardio day is credited by any cardio activity;
//   • a strength day is NEVER credited by cardio, and a cardio day is NEVER
//     credited by strength (the kind gate — regions alone can't express it, so
//     the session carries both its regions AND whether it had cardio).
export function sessionCreditsDay(
  session: { regions: MuscleRegion[]; hasCardio: boolean },
  dayFocus: MuscleRegion[]
): boolean {
  const isCardioDay = dayFocus.length === 0;
  if (isCardioDay) return session.hasCardio;
  return session.regions.some((r) => dayFocus.includes(r));
}

// ---- The unified core ----

// Rank the day's workout items and compute the shared focus/exercise suggestion.
// The result is surface-agnostic; lib/coaching formats it into Recommendation
// cards (wrapping it with rest/intensity) and lib/notifications formats it into
// the Telegram reminder. Rest/recovery is intentionally NOT decided here.
export function recommendNextWorkout(input: NextWorkoutInput): NextWorkout {
  const { routine, strength, cardio, today } = input;

  // Injury context (#838): the user's declared constraints shape the suggestion — active
  // regions excluded (disclosed), recovering regions tempered — while condition notes
  // (#666) ride ALONGSIDE unchanged. Computed once so every branch's result agrees.
  const constraints = input.injuries ?? [];
  const excluded = computeExcludedRegions(constraints);
  const trainingContext = {
    excludedRegions: excludedRegionDisclosures(constraints),
    temperedRegions: [...computeTemperedRegions(constraints)],
    considerations: input.considerations ?? [],
  };

  // A behind region/group target fully within an excluded region is dropped from the
  // nag/behind set (the routine-gap exclusion); type targets and partially-trainable
  // targets stay.
  const behind = routine
    .filter((t) => !t.met)
    .filter((t) => !targetFullyExcluded(t, excluded));
  const behindTargets = behind.map(toBehindTarget);

  // Scope the shared strength suggestion to the most-overdue behind strength
  // target when the routine has one; otherwise leave it unscoped (habit).
  const behindStrength = behind
    .filter((t) => !isCardioTarget(t))
    .sort(byFractionComplete)[0];
  // Routine-aware path (#740): an active routine resolves TODAY'S day into a
  // filled session — the authoritative recommendation. Guarded so that with NO
  // active routine the function is byte-for-byte its prior behavior (the whole
  // block below never runs, and `session` stays null everywhere).
  if (input.activeRoutine) {
    const session = resolveRoutineSession(input.activeRoutine, input);
    if (session) {
      const exercises = session.slots.map((s) => s.exercise).filter(Boolean);
      // Lead lift == the day's first slot; its seed drives the next-set target
      // (null on cold start → no load shown). Keeps `primary` aligned with
      // `exercises[0]`, the same contract withEquipmentPreference upholds.
      const lead = session.slots[0]?.seed ?? null;
      const item: NextWorkoutItem =
        session.kind === "cardio"
          ? {
              kind: "cardio",
              reason: "routine-day",
              exercise: null,
              activity: pickOldestCardio(cardio, today),
              target: null,
            }
          : {
              kind: "strength",
              reason: "routine-day",
              exercise: lead,
              activity: null,
              target: null,
            };
      // A strength day whose focus is ENTIRELY excluded by an active injury can't be
      // trained around it — a surface offers a SUBSTITUTION day instead of marking it
      // missed (#838). Disclosed via excludedRegions; the authored slate itself is kept.
      const substitutionSuggested =
        session.kind === "strength" &&
        session.focus.length > 0 &&
        session.focus.every((r) => excluded.has(r));
      return {
        items: [item],
        focus: session.focus,
        exercises,
        primary: lead,
        behind: behindTargets,
        session,
        substitutionSuggested,
        ...trainingContext,
      };
    }
    // An active routine with no days can't resolve a session — fall through to the
    // prior weekly-target / habit composition below.
  }

  const { focus, exercises, primary } = computeStrengthWorkout(
    input,
    behindStrength ?? null,
    excluded
  );

  const base = {
    focus,
    exercises,
    primary,
    behind: behindTargets,
    session: null,
    substitutionSuggested: false,
    ...trainingContext,
  };
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
