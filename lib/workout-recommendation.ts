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
import { weekdayOfDateStr, WEEKDAYS_LONG } from "./date";
import { daysLeftPhrase, reachableWithoutToday } from "./effort-class";
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
import type { EnduranceArm } from "./endurance-plan";
import type {
  StrengthRecent,
  CardioRecent,
  RoutineTargetProgress,
} from "./coaching";
import {
  parkedVerdict,
  pickIndoorAlternative,
  type ParkQuantity,
  type ParkReason,
  type PrecipitationHour,
  type ToleranceEnvelope,
} from "./weather-training";
import type { WeatherDay } from "./weather-situations";

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

// ---- Per-region recovery windows (#1673) ----
//
// The focus's recovery exclusion used to be exactly ONE day deep — "not the region you
// trained yesterday". Composed with week-scoped target counts it produced the owner's
// Monday bug: push Friday, pull Saturday, rest Sunday, and Monday's reminder recommended
// BACK, because the fresh week read 0/2 for every region and Saturday's pull session sat
// one day outside a one-day exclusion. The weekly count is a CALENDAR construct; muscle
// recovery is a rolling PHYSIOLOGICAL window, and the focus conflated them exactly at the
// week boundary.
//
// The windows below are the fix's hard half (the soft half is recency ordering, further
// down): how many full REST DAYS a region wants before it is eligible for the focus again.
// Large groups take longer than small ones. Day-granular and rolling, so the rule is
// week-boundary-blind by construction — the weekly COUNTS stay week-scoped, which is
// correct for targets; only ELIGIBILITY and ORDERING stop being calendar-bound.
//
// A region trained `n` days ago has banked `n - 1` full rest days, so it is inside its
// window while `daysSince <= windowDays` and eligible once it has banked the window's
// worth: back trained Saturday is still inside its 2-day window on Monday (1 rest day),
// while a rotation that revisits a region every third day lands ON the boundary
// (eligible), so a dense plan never trips this routinely. Named constants,
// adjust-in-review.
export const LARGE_REGION_RECOVERY_DAYS = 2;
export const SMALL_REGION_RECOVERY_DAYS = 1;

// Glutes are unlisted in the issue; they train and recover with Legs (the Lower group),
// so they take the large-group window rather than silently falling to the small one.
const REGION_RECOVERY_DAYS: Record<MuscleRegion, number> = {
  Chest: LARGE_REGION_RECOVERY_DAYS,
  Back: LARGE_REGION_RECOVERY_DAYS,
  Legs: LARGE_REGION_RECOVERY_DAYS,
  Glutes: LARGE_REGION_RECOVERY_DAYS,
  Shoulders: SMALL_REGION_RECOVERY_DAYS,
  Arms: SMALL_REGION_RECOVERY_DAYS,
  Core: SMALL_REGION_RECOVERY_DAYS,
};

/** The recovery window (in days) a muscle region wants before it leads a session again. */
export function regionRecoveryDays(region: MuscleRegion): number {
  return REGION_RECOVERY_DAYS[region] ?? SMALL_REGION_RECOVERY_DAYS;
}

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

// A behind target ordered for display, marked when it is the one that DROVE today's
// suggestion (issue #1709).
export interface OrderedBehindTarget extends BehindTarget {
  driving: boolean;
}

// Order the "behind this week" list so it EXPLAINS the suggestion instead of sitting
// beside it (#1709). The message used to recommend Back and then list Chest first,
// because `behind` was flattened to opaque strings in routine-declaration order, with
// nothing connecting the two halves and the target that actually drove the suggestion
// — the one at 0/2 — buried mid-line.
//
// The driving target leads; the rest follow by DEFICIT (largest `perWeek - count` gap
// first), ties broken by routine order for stability. Living here, beside the
// recommendation, means the Telegram nudge, the dashboard coaching card and the
// Training overview all format one ordered result and a future surface cannot
// reintroduce a different order (#221).
//
// `driverIds` are the behind targets whose sessions the message actually NAMES — empty
// (or null) when the suggestion came from habit/variety rather than a behind target, in
// which case nothing is marked and the list is pure deficit order.
//
// PLURAL since #2016: a routine behind on both cardio and strength has the message name
// BOTH sessions, so both targets are addressed and both are marked. The ordering rule is
// unchanged — driving-first, then deficit — so two drivers simply lead in deficit order.
// A bare number is still accepted, which is what the single-driver call sites and the
// #1709 unit tests pass.
export function orderBehindTargets(
  behind: readonly BehindTarget[],
  driverIds: number | readonly number[] | null
): OrderedBehindTarget[] {
  const drivers = new Set<number>(
    driverIds == null
      ? []
      : typeof driverIds === "number"
        ? [driverIds]
        : driverIds
  );
  const deficit = (t: BehindTarget) => t.perWeek - t.count;
  return behind
    .map((t, i) => ({
      ...t,
      // A driver that is somehow no longer behind can't be marked — it wouldn't be in
      // this list at all, and a marker pointing at nothing is worse than none.
      driving: t.id != null && drivers.has(t.id),
      order: i,
    }))
    .sort(
      (a, b) =>
        Number(b.driving) - Number(a.driving) ||
        deficit(b) - deficit(a) ||
        a.order - b.order
    )
    .map(({ order: _order, ...t }) => t);
}

// A region held out of today's focus by its recovery window (#1673), with everything a
// surface needs to say so out loud. The exclusion is DISCLOSED, never silent — the #838
// rule for anything that re-ranks the suggestion.
export interface RestingRegion {
  region: MuscleRegion;
  lastDate: string; // YYYY-MM-DD, its most recent session in the bounded window
  daysSince: number;
  windowDays: number;
}

// The tight-week override (#1673 decision 4): a behind target that can no longer be met
// without today beats the recovery window — the same "pace wins, with acknowledgment"
// posture as #1672's same-day deferral. Carries both facts the message must state: the
// recent session, and the pace that justifies training the region anyway.
export interface RecoveryOverride {
  region: MuscleRegion;
  lastDate: string;
  daysSince: number;
  target: BehindTarget;
  // On-days left in the week window AFTER today — the feasibility denominator the
  // override was decided on, carried so the message can state the pace precisely.
  daysLeftInWindow: number;
}

// How the recovery windows shaped today's focus. Every surface reads this one result.
export interface RecoveryWindowState {
  // In-scope regions currently inside their window, least-recently-trained first.
  resting: RestingRegion[];
  // EVERY in-scope candidate is inside its window, so the slot does not force a pick —
  // the surface routes through the rest framing instead ("everything's fresh; recovery
  // day"). The window is a physiological constraint, not a soft penalty: normal
  // recommendations resume the moment a window opens.
  allFresh: boolean;
  // Set when the focus's lead region is one the window would have deferred, released by
  // a tight week. Null on a loose week (which yields the rest note above instead).
  override: RecoveryOverride | null;
}

function noRecoveryState(): RecoveryWindowState {
  return { resting: [], allFresh: false, override: null };
}

// "Back was Saturday — 1/2 with only today left." The acknowledgment a tight-week
// override owes the reader: it names the recent session AND the pace fact, so a nudge
// that contradicts the recovery window never reads as the app having forgotten what you
// did. Pure, so the Telegram nudge, the dashboard card and the Training overview render
// one string (#221).
//
// The days-left phrase itself comes from `daysLeftPhrase` (#1822 item 1) — the SAME
// helper the same-day acknowledgment states, so the two pace formatters cannot answer
// the 0-days-after-today edge differently again.
export function recoveryOverrideLine(o: RecoveryOverride): string {
  const when =
    o.daysSince === 1
      ? "yesterday"
      : (WEEKDAYS_LONG[weekdayOfDateStr(o.lastDate)] ?? o.lastDate);
  return `${o.region} was ${when} — ${o.target.count}/${o.target.perWeek} with ${daysLeftPhrase(
    o.daysLeftInWindow
  )}.`;
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
  // Weather context (#1724). When present, OUTDOOR activities whose conditions fall
  // outside the profile's own revealed tolerance are PARKED: excluded from the cardio
  // pick and from variety staleness, with the reason disclosed and the mapped indoor
  // alternative offered in their place. Absent ⇒ no gating whatsoever, so every
  // existing caller and test keeps its prior ordering (silence over guessing — a
  // profile with no weather data must not be re-ranked on a guess).
  weather?: WeatherTrainingContext | null;
  // The plan-aware cardio ARM for the soonest active endurance plan (#839) — a calm
  // pre-computed one-line note ("… plan · 6 weeks to go: ~28 km this week, long run ~12 km
  // due …"). Rides ALONGSIDE the unchanged recommendation like the condition notes; the
  // gather already applies the illness pause (#837) so an open episode yields null. Passed
  // straight through to `endurancePlanArm` on the result. Absent / null ⇒ nothing.
  endurancePlanArm?: EnduranceArm | null;
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
  // The behind targets whose sessions this recommendation actually NAMES (#2015/#2016).
  // The core names its own drivers rather than leaving a formatter to infer them from
  // array position: `items[0]` is a FIXED order (cardio, then strength), so reading the
  // driver off it marked the cardio target on a message that suggested a back workout.
  // One element per routine-gap item carrying an identified target — today at most two
  // (the cardio session and the strength session), both of which the message names, so
  // the marker can never point at something unrendered. Empty on every other path.
  driverIds: number[];
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
  // The plan-aware cardio ARM (#839) — the soonest active endurance plan's calm one-line
  // note, riding alongside like the considerations. Null when no active plan / during an
  // open illness episode (the gather applies the pause). Pass-through of the input.
  endurancePlanArm: EnduranceArm | null;
  // Outdoor activities PARKED by today's conditions (#1724), each with the reason and
  // the indoor stand-in that took its slot. NEVER a silent disappearance (the #838
  // always-disclosed rule): every surface renders this alongside the suggestion, so the
  // ride's absence is explained rather than mysterious. Empty when no weather context,
  // no outdoor activity in range, or conditions are fine.
  parked: ParkedActivity[];
  // How the per-region recovery windows shaped today's focus (#1673): which regions are
  // resting, whether EVERY candidate is (the rest reframe), and the tight-week override
  // when pace beat the window. Always present; inert (empty/false/null) on the routine
  // path and whenever no dated history is available.
  recovery: RecoveryWindowState;
}

// The weather inputs the core reads. Assembled once by the DB gather so the Telegram
// nudge, the dashboard card and the Training overview inherit one answer (#221/#221).
export interface WeatherTrainingContext {
  // Today's cached conditions, or null when the day has no cached row (⇒ no gating).
  today: WeatherDay | null;
  // Per-activity tolerance envelopes, keyed by the FOLDED activity name — derived from
  // the profile's OWN history, never assumed.
  envelopes: Map<string, ToleranceEnvelope>;
  // Whether the profile can actually do an indoor candidate (logged it, or owns the
  // gear). The engine never invents a machine someone doesn't have.
  canDo: (candidate: string) => boolean;
  // Today's HOURLY precipitation in the profile's local day (#1967), for the timing
  // clause of a wet park's description. Absent/empty ⇒ the description renders intensity
  // alone, which is the intended degradation — never an invented "until the afternoon".
  hoursToday?: readonly PrecipitationHour[];
}

// One parked outdoor activity, with everything a surface needs to disclose it.
export interface ParkedActivity {
  activity: string;
  reason: ParkReason;
  // What `value` measures — °C for cold/hot, mm for wet (#1967). Carried rather than
  // re-derived so no surface has to remember which reason means which unit.
  quantity: ParkQuantity;
  // The condition value in canonical units (°C for cold/hot, mm for wet). The surface
  // formats it through parkedFigure, in the login's units.
  value: number | null;
  // The day's WMO weather code and hourly precipitation — the facts a WET park's
  // plain-language description is built from ("heavy rain in the morning"). Carried here
  // so the disclosure formatter needs nothing but the ParkedActivity.
  weatherCode: number | null;
  precipitationHours: readonly PrecipitationHour[];
  // The indoor stand-in offered in its place, or null when the profile can do none of
  // the mapped alternatives — the caller then falls through to its normal next-best
  // pick, with this disclosure still rendered.
  alternative: string | null;
  // Whether the envelope that parked it was REVEALED from this profile's own sessions
  // (vs the permissive fallback constants). Surfaces can be honest about which.
  revealed: boolean;
}

// ---- Target helpers ----

// WHICH TARGETS A WORKOUT MESSAGE MAY CARRY (#2017).
//
// The rule, stated once: a target belongs in a workout recommendation only if THIS
// message can help you close it. The engine suggests lifts and cardio sessions; it
// cannot suggest a light-therapy session, a mobility routine or a plate of vegetables,
// so naming those targets asks the reader to act on something the message never offered
// — and, for a practice, is a SECOND contact for a fact that already has its own
// pace-aware `practice` nudge (the attention doctrine's contact-consent rule).
//
// An ALLOWLIST, never a subtraction. The pool used to be "everything that is not
// literally `type:cardio`", so every scope kind a sibling feature added — food groups,
// mobility regions, substance caps, wellness practices — opted itself in silently. A new
// scope kind is now excluded until someone writes down why it can be closed here.
//
// Each entry carries its reason because the reason is the decision; the completeness
// test reads this table so the next scope kind cannot join by omission.
export const WORKOUT_TARGET_SCOPES: Record<
  string,
  { admitted: boolean; reason: string }
> = {
  region: {
    admitted: true,
    reason: "resolves to muscle regions the message's exercise list names",
  },
  group: {
    admitted: true,
    reason: "resolves to muscle regions the message's exercise list names",
  },
  type: {
    admitted: true,
    reason:
      "resolves to a session the message names — a strength slate or a cardio activity",
  },
  practice: {
    admitted: false,
    reason:
      "a wellness practice has its OWN pace-aware nudge (the `practice` kind); carrying it here would be a second contact for a fact that already has one",
  },
  mobility_region: {
    admitted: false,
    reason:
      "physical training, but the engine suggests no mobility work today (#840), so the message cannot help close it; revisit if a mobility suggestion ever ships",
  },
  substance: {
    admitted: false,
    reason:
      "per_week is an inverted CAP (#998) — 'behind' there means UNDER the limit, i.e. good — so listing it as a deficit to close inverts the goal",
  },
  food_group: {
    admitted: false,
    reason: "not training; nothing a workout suggestion can close",
  },
};

// Whether a frequency-target scope kind may appear in a workout recommendation. An
// unregistered kind is OUT — the allowlist's whole point.
export function isWorkoutTargetScope(scopeKind: string): boolean {
  return WORKOUT_TARGET_SCOPES[scopeKind]?.admitted === true;
}

function isWorkoutTarget(t: RoutineTargetProgress): boolean {
  return isWorkoutTargetScope(t.target.scope_kind);
}

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

// Each region's most recent session inside the bounded dated window. The one recency
// index every #1673 decision reads: the scope-target pick, the within-tier ordering,
// and the per-region recovery windows.
function lastTrainedByRegion(
  rows: readonly DatedExercise[]
): Map<MuscleRegion, string> {
  const last = new Map<MuscleRegion, string>();
  for (const r of rows) {
    const reg = regionForExercise(r.exercise);
    if (!reg) continue;
    const cur = last.get(reg);
    if (!cur || r.date > cur) last.set(reg, r.date);
  }
  return last;
}

// The dated rows inside the recommendation's lookback window.
function datedWithinWindow(input: NextWorkoutInput): DatedExercise[] {
  return (input.datedExercises ?? []).filter((r) =>
    within(r.date, input.today, WORKOUT_LOOKBACK_DAYS)
  );
}

// Whether a region is still inside its recovery window as of `today` (#1673). Same-day
// training is deliberately NOT counted: "you already trained today" is a different
// question, owned by the trained-today branch and #1672's same-day deferral.
function regionResting(
  region: MuscleRegion,
  lastByRegion: ReadonlyMap<MuscleRegion, string>,
  today: string
): boolean {
  const last = lastByRegion.get(region);
  if (last == null) return false;
  const daysSince = daysBetween(last, today);
  return daysSince >= 1 && daysSince <= regionRecoveryDays(region);
}

// The behind STRENGTH target the shared suggestion is scoped to. Least-complete first,
// as before — but with two #1673 corrections ahead of the old alphabetical tie-break,
// which was exactly as calendar-blind as the focus ordering the issue reports ("Back
// 0/2" beat "Legs 0/2" on the letter B while back was 36 hours old):
//
//   • a target with at least one region OUT of its recovery window outranks one whose
//     regions are all resting — otherwise the scope lands on an untrainable target and
//     the day reads as all-fresh while a trainable behind target sits right there. The
//     scope only settles on an all-resting target when EVERY behind strength target is,
//     which is precisely the all-fresh corner (decision 3);
//   • ties on completeness — which the weekly reset creates wholesale — go to the
//     target whose regions have rested longest. A target with no history in the window
//     is maximally stale and leads.
function pickScopeTarget(
  behindStrength: RoutineTargetProgress[],
  lastByRegion: ReadonlyMap<MuscleRegion, string>,
  today: string,
  paceReleased: ReadonlySet<MuscleRegion>
): RoutineTargetProgress | undefined {
  const trainable = (t: RoutineTargetProgress): boolean => {
    const regions = regionsForTarget(t);
    // A type target names no region, so nothing constrains it.
    if (regions.length === 0) return true;
    return regions.some(
      (r) => paceReleased.has(r) || !regionResting(r, lastByRegion, today)
    );
  };
  const freshness = (t: RoutineTargetProgress): string => {
    const dates = regionsForTarget(t)
      .map((r) => lastByRegion.get(r))
      .filter((d): d is string => d != null);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : "";
  };
  // The fraction alone — byFractionComplete folds in its own alphabetical tie-break,
  // which is the very ordering recency has to displace here.
  const fraction = (t: RoutineTargetProgress) =>
    t.count / Math.max(1, t.per_week);
  return [...behindStrength].sort(
    (a, b) =>
      Number(trainable(b)) - Number(trainable(a)) ||
      fraction(a) - fraction(b) ||
      freshness(a).localeCompare(freshness(b)) ||
      a.target.scope_value.localeCompare(b.target.scope_value)
  )[0];
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
// SEASONAL PARKING MUST NOT READ AS STALENESS (#1724 part 4). The variety ranker
// favours the least-recently-done activity, which without this exclusion INVERTS the
// desired behavior: as winter parks the bike, the ride goes stale and gets pushed
// HARDER exactly when conditions are worst. Parked activities are excluded from
// candidacy while parked and return naturally when the gate lifts — the comeback needs
// no special case, just the exclusion ending.
export function pickOldestCardio(
  cardio: CardioRecent[],
  today: string,
  parkedActivities: ReadonlySet<string> = new Set()
): CardioRecent | null {
  return (
    [...cardio]
      .filter((c) => !parkedActivities.has(c.activity.trim().toLowerCase()))
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
  excluded: Set<MuscleRegion>,
  paceReleased: ReadonlyMap<
    MuscleRegion,
    { target: BehindTarget; daysLeftInWindow: number }
  >
): {
  focus: MuscleRegion[];
  exercises: string[];
  primary: StrengthRecent | null;
  recovery: RecoveryWindowState;
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

  const dated = datedWithinWindow(input);

  if (dated.length > 0) {
    // In scope AND not excluded by an active injury (#838) — the exclusion is the user's
    // own constraint, so it re-ranks the focus (unlike a condition, which never gates).
    const inScope = (r: MuscleRegion) =>
      (candidate == null || candidate.has(r)) && !excluded.has(r);
    const { focus: focusRegions, recovery } = focusFromHistory(
      dated,
      today,
      behindRegions,
      inScope,
      paceReleased
    );
    const exercises = rankExercises(dated, focusRegions);
    return {
      ...withEquipmentPreference(focusRegions, exercises, input),
      recovery,
    };
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
  return {
    ...withEquipmentPreference(
      focus.slice(0, 3),
      qualifying.map((s) => s.exercise).slice(0, 5),
      input
    ),
    // No dated history ⇒ no recency to reason about, so the windows are inert here
    // (the aggregate path already picks least-recently-trained first).
    recovery: noRecoveryState(),
  };
}

// The regions a TIGHT week releases from their recovery window (#1673 decision 4). A
// behind target whose remaining sessions no longer fit in the on-days after today can't
// be met without today, so pace wins over the window — the same exception #1672 makes
// for same-day deferral, and it carries the same obligation to say so out loud.
//
// The override INCREASES contact, so it needs positive evidence: a target with no
// `daysLeftInWindow` (fixture-shaped rows; production always supplies it) is treated as
// LOOSE and releases nothing. Injury-excluded regions are never released — that
// exclusion is the user's own declared constraint, not a pace question.
function paceReleasedRegions(
  routine: RoutineTargetProgress[],
  excluded: Set<MuscleRegion>
): Map<MuscleRegion, { target: BehindTarget; daysLeftInWindow: number }> {
  const released = new Map<
    MuscleRegion,
    { target: BehindTarget; daysLeftInWindow: number }
  >();
  for (const t of routine) {
    if (t.met) continue;
    const daysLeftInWindow = t.daysLeftInWindow;
    if (daysLeftInWindow == null) continue;
    // ONE feasibility predicate, shared with the #1672 deferral decision (#221) — the
    // `label` it carries is presentation only and unused by the test.
    const reachable = reachableWithoutToday({
      scopeKind: t.target.scope_kind,
      scopeValue: t.target.scope_value,
      label: t.target.scope_value,
      count: t.count,
      perWeek: t.per_week,
      daysLeftInWindow,
    });
    if (reachable) continue;
    for (const r of regionsForTarget(t)) {
      if (excluded.has(r) || released.has(r)) continue;
      released.set(r, { target: toBehindTarget(t), daysLeftInWindow });
    }
  }
  return released;
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

// Focus regions from dated history: behind ∩ usual, then behind, then usual — each
// excluding regions still inside their per-region recovery window and out-of-scope
// regions; falling back to the least-recently-trained in-scope regions when nothing
// matched. Up to three regions.
//
// TWO MECHANISMS, DELIBERATELY BOTH (#1673). Within every tier the order is
// LEAST-RECENTLY-TRAINED FIRST — rolling, so it is blind to the week boundary that
// flattened the old routine-declaration order to "everything is equally 0/N". Ordering
// alone can't demote across tiers, though (a fresh region that is also the weekday habit
// sits in a HIGHER tier and wins regardless of recency), so the hard recovery-window
// exclusion still crosses tiers. The reported Monday case fails both ways without both:
// back is the fresher region AND the one still inside its window.
//
// Same-day training is intentionally NOT treated as inside the window: "you already
// trained today" is a different question, owned by the trained-today branch and the
// #1672 same-day deferral, and folding it in here would quietly change that behavior.
function focusFromHistory(
  rows: DatedExercise[],
  today: string,
  behindRegions: MuscleRegion[],
  inScope: (r: MuscleRegion) => boolean,
  paceReleased: ReadonlyMap<
    MuscleRegion,
    { target: BehindTarget; daysLeftInWindow: number }
  >
): { focus: MuscleRegion[]; recovery: RecoveryWindowState } {
  const todayWeekday = weekdayOfDateStr(today);

  const lastByRegion = lastTrainedByRegion(rows);

  // In-scope regions inside their recovery window, and the subset a tight week releases.
  const inWindow: RestingRegion[] = [];
  for (const [region, lastDate] of lastByRegion) {
    if (!inScope(region)) continue;
    const daysSince = daysBetween(lastDate, today);
    const windowDays = regionRecoveryDays(region);
    if (daysSince >= 1 && daysSince <= windowDays)
      inWindow.push({ region, lastDate, daysSince, windowDays });
  }
  inWindow.sort((a, b) => a.lastDate.localeCompare(b.lastDate));
  const resting = inWindow.filter((r) => !paceReleased.has(r.region));
  const excluded = new Set(resting.map((r) => r.region));

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
  // Least-recently-trained first inside each tier; a region with no session in the
  // window is maximally stale and leads (the empty string sorts before any date). Ties
  // keep their incoming order — routine order for behind targets, habit strength for
  // usual ones — so the result stays deterministic.
  const staleFirst = (regions: MuscleRegion[]): MuscleRegion[] =>
    regions
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          (lastByRegion.get(a.r) ?? "").localeCompare(
            lastByRegion.get(b.r) ?? ""
          ) || a.i - b.i
      )
      .map((x) => x.r);

  for (const r of staleFirst(
    usualRegions.filter((u) => behindRegions.includes(u))
  ))
    add(r);
  for (const r of staleFirst(behindRegions)) add(r);
  for (const r of staleFirst(usualRegions)) add(r);

  // Fallback: the least-recently-trained in-scope regions (overdue) that are out of
  // their recovery window. Only regions with history — never-trained ones have no
  // exercises.
  if (focus.length === 0) {
    [...lastByRegion.entries()]
      .filter(([r]) => !excluded.has(r) && inScope(r))
      .sort((a, b) => a[1].localeCompare(b[1])) // oldest last-trained first
      .slice(0, 2)
      .forEach(([r]) => add(r));
  }

  const picked = focus.slice(0, 3);
  // The lead region is one the window would have deferred ⇒ a tight week released it,
  // and the message owes both facts (#1673 decision 4). Only the LEAD can carry the
  // override: it is what the suggestion actually asks for.
  const releasedLead = picked[0];
  const overrideSource =
    releasedLead != null ? paceReleased.get(releasedLead) : undefined;
  const overrideWindow =
    overrideSource != null
      ? inWindow.find((w) => w.region === releasedLead)
      : undefined;
  return {
    focus: picked,
    recovery: {
      resting,
      // Every in-scope candidate is resting: nothing to suggest, and it's a recovery
      // day rather than an empty result. A focus that is empty for want of HISTORY is
      // not all-fresh — there has to be something actually resting.
      allFresh: picked.length === 0 && resting.length > 0,
      override:
        overrideSource != null && overrideWindow != null
          ? {
              region: releasedLead!,
              lastDate: overrideWindow.lastDate,
              daysSince: overrideWindow.daysSince,
              target: overrideSource.target,
              daysLeftInWindow: overrideSource.daysLeftInWindow,
            }
          : null,
    },
  };
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

// The active routine's prescribed LOADING cadence (#1115 Fix A): how many consecutive
// STRENGTH (loading) days the plan itself schedules, and how many loading days it
// prescribes per rotation cycle. A routine day with a non-empty `focus` is a loading
// (strength) day; a `kind:"cardio"` day (empty `focus`) is ACTIVE RECOVERY by intent
// and breaks the run. The rotation is CIRCULAR (a sequence, not a calendar), so the
// consecutive run wraps the cycle boundary. Null when there's no routine, it has no
// days, or it has no loading days at all (a cardio-only plan) — callers then keep the
// generic thresholds. Used to lift the schedule-based rest triggers so a 6-day PPL
// can't trip a generic 4-day rule (only DEVIATION from the plan warrants a
// schedule-based rest nudge). Pure over the day shapes.
export function routineLoadingCadence(
  routine: ActiveRoutineInput | null | undefined
): { maxConsecutiveLoadingDays: number; loadingDaysPerCycle: number } | null {
  if (!routine || routine.days.length === 0) return null;
  const loading = routine.days.map((d) => d.focus.length > 0);
  const n = loading.length;
  const total = loading.filter(Boolean).length;
  if (total === 0) return null;
  // Every day is a loading day — the run never breaks within the rotation, so it's a
  // full lap (a rest is taken OUTSIDE the sequence, which the model doesn't encode).
  if (total === n) {
    return { maxConsecutiveLoadingDays: n, loadingDaysPerCycle: n };
  }
  // Longest circular run of consecutive loading days: walk two laps and cap the run at
  // n (a run can't exceed one full lap once a non-loading day exists).
  let best = 0;
  let run = 0;
  for (let i = 0; i < n * 2; i++) {
    if (loading[i % n]) {
      run += 1;
      best = Math.max(best, Math.min(run, n));
    } else {
      run = 0;
    }
  }
  return { maxConsecutiveLoadingDays: best, loadingDaysPerCycle: total };
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
// Which of the profile's recent cardio activities today's conditions park, each with
// the indoor stand-in it can actually do. NO WEATHER CONTEXT ⇒ NOTHING PARKED: the
// engine has no opinion without data, and today's pick is byte-for-byte what it was
// before this feature existed.
function resolveParked(
  cardio: readonly CardioRecent[],
  weather: WeatherTrainingContext | null
): ParkedActivity[] {
  if (!weather || !weather.today) return [];
  const out: ParkedActivity[] = [];
  const seen = new Set<string>();
  for (const c of cardio) {
    const key = c.activity.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = parkedVerdict(
      c.activity,
      weather.today,
      weather.envelopes.get(key) ?? null
    );
    if (!verdict.parked || verdict.reason == null || verdict.quantity == null)
      continue;
    out.push({
      activity: c.activity,
      reason: verdict.reason,
      quantity: verdict.quantity,
      value: verdict.value,
      weatherCode: weather.today.weatherCode,
      precipitationHours: weather.hoursToday ?? [],
      alternative: pickIndoorAlternative(c.activity, weather.canDo),
      revealed: verdict.revealed,
    });
  }
  return out;
}

// The drivers a result declares (#2015): every routine-gap item that names an
// identified behind target. Derived from the items the message renders, so a target is
// marked BECAUSE its session is named — the two cannot drift apart again, and adding a
// third routine-gap item later can't silently re-point the arrow.
function driverIdsOf(items: readonly NextWorkoutItem[]): number[] {
  return items
    .filter((i) => i.reason === "routine-gap")
    .map((i) => i.target?.id)
    .filter((id): id is number => id != null);
}

export function recommendNextWorkout(input: NextWorkoutInput): NextWorkout {
  const { routine, strength, cardio, today } = input;

  // Injury context (#838): the user's declared constraints shape the suggestion — active
  // regions excluded (disclosed), recovering regions tempered — while condition notes
  // (#666) ride ALONGSIDE unchanged. Computed once so every branch's result agrees.
  const constraints = input.injuries ?? [];
  const excluded = computeExcludedRegions(constraints);
  // Weather parking (#1724), resolved ONCE so every branch's result agrees — and so
  // the Telegram nudge, dashboard card and Training overview inherit the same answer
  // (#221). The candidate set is the profile's own recent cardio: an activity it has
  // never done cannot be parked, because there is nothing to park.
  const parked = resolveParked(cardio, input.weather ?? null);
  const parkedNames = new Set(
    parked.map((p) => p.activity.trim().toLowerCase())
  );

  const trainingContext = {
    excludedRegions: excludedRegionDisclosures(constraints),
    temperedRegions: [...computeTemperedRegions(constraints)],
    considerations: input.considerations ?? [],
    endurancePlanArm: input.endurancePlanArm ?? null,
    parked,
  };

  // A behind region/group target fully within an excluded region is dropped from the
  // nag/behind set (the routine-gap exclusion); type targets and partially-trainable
  // targets stay.
  //
  // The scope allowlist is applied HERE, at the source (#2017), because `behind` feeds
  // BOTH the scope pick and the rendered "Behind this week" list: restricting it once
  // keeps a practice/food/substance target from scoping a strength workout AND from
  // being listed as a deficit this message asks the reader to close.
  const behind = routine
    .filter(isWorkoutTarget)
    .filter((t) => !t.met)
    .filter((t) => !targetFullyExcluded(t, excluded));
  const behindTargets = behind.map(toBehindTarget);

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
              activity: pickOldestCardio(cardio, today, parkedNames),
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
        driverIds: driverIdsOf([item]),
        focus: session.focus,
        exercises,
        primary: lead,
        behind: behindTargets,
        session,
        substitutionSuggested,
        // The routine day dictates the focus, so the generic recovery windows never
        // gate it (#1673 decision 2's dense-plan note: a routine's own cadence IS the
        // plan). Inert here by construction.
        recovery: noRecoveryState(),
        ...trainingContext,
      };
    }
    // An active routine with no days can't resolve a session — fall through to the
    // prior weekly-target / habit composition below.
  }

  // Recovery-window bookkeeping (#1673), resolved once so the scope pick, the focus
  // ordering and the disclosure all read one answer.
  const paceReleased = paceReleasedRegions(routine, excluded);
  // Scope the shared strength suggestion to the most-overdue behind strength target
  // when the routine has one; otherwise leave it unscoped (habit).
  const behindStrength = pickScopeTarget(
    behind.filter((t) => !isCardioTarget(t)),
    lastTrainedByRegion(datedWithinWindow(input)),
    today,
    new Set(paceReleased.keys())
  );

  const { focus, exercises, primary, recovery } = computeStrengthWorkout(
    input,
    behindStrength ?? null,
    excluded,
    paceReleased
  );

  const base = {
    focus,
    exercises,
    primary,
    behind: behindTargets,
    session: null,
    substitutionSuggested: false,
    recovery,
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
        activity: pickOldestCardio(cardio, today, parkedNames),
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
    return { items, driverIds: driverIdsOf(items), ...base };
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
    return { items, driverIds: driverIdsOf(items), ...base };
  }
  if (primary) {
    items.push({
      kind: "strength",
      reason: "habit",
      exercise: primary,
      activity: null,
      target: null,
    });
    return { items, driverIds: driverIdsOf(items), ...base };
  }
  const activity = pickOldestCardio(cardio, today, parkedNames);
  if (activity) {
    items.push({
      kind: "cardio",
      reason: "habit",
      exercise: null,
      activity,
      target: null,
    });
    return { items, driverIds: driverIdsOf(items), ...base };
  }
  items.push({
    kind: "setup",
    reason: "empty",
    exercise: null,
    activity: null,
    target: null,
  });
  return { items, driverIds: driverIdsOf(items), ...base };
}
