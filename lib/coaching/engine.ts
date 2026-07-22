// Rule-based coaching engine: the deterministic "one clear thing to do today"
// recommender. Pure and client-safe — no DB/network.
import { frequencyScopeLabel } from "../goals";
import { formatRelativeDate } from "../format-date";
import { shiftDateStr } from "../date";
import { currentStreak } from "../streak";
import { classifyPolarization, type PolarizedSplit } from "../training-zones";
import {
  recommendNextWorkout,
  routineLoadingCadence,
  type ActiveRoutineInput,
  type DatedExercise,
  type NextWorkout,
  type NextWorkoutItem,
} from "../workout-recommendation";
import {
  excludedRegionLabel,
  RECOVERING_LOAD_FACTOR,
  type InjuryConstraint,
} from "../injury-model";
import type { ConditionConsideration } from "../condition-training-considerations";
import type { EnduranceArm } from "../endurance-plan";
import type { EquipmentAvailability } from "../equipment-availability";
import type { WeightUnit } from "../settings";
import type { AppRoute } from "../hrefs";
import { regionForExercise, type MuscleRegion } from "../lifts";
import {
  contextualNextSet,
  suggestNextSet,
  nextSetText,
  type NextSet,
  type NextSetSeed,
} from "./strength";
import { coachingHeldReason, type Reason } from "../reasons";

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
  | "rest"
  | "cardio"
  | "strength"
  | "ontrack"
  | "setup"
  | "intensity"
  // Situation-aware coaching (issue #837): the illness HOLD note (routine nudges
  // paused while an episode is open) and the post-episode ease-back rec.
  | "illness";
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
  // Structured, first-class reasons (issue #656) carried ALONGSIDE `detail` — the
  // "why" as DATA a compact surface can render without re-deriving. Set by the
  // situation-aware recs (the illness hold note's "Held — illness episode open");
  // carried across the findings bus by recommendationToFinding. Absent for the
  // ordinary training/rest recs whose `detail` already stands alone.
  reasons?: Reason[];
  // Calm context lines riding ALONGSIDE the recommendation (issues #666/#838), carried on
  // the ONE model so every surface (Training-overview card, dashboard widget, Telegram)
  // renders the same text (#221): active-injury exclusion disclosures ("Avoiding Chest
  // (right shoulder injury)") and curated condition consideration notes. Informational —
  // the recommendation itself is unchanged. Absent when there's no injury/condition
  // context.
  notes?: string[];
  // Additional concurrently-firing rest reasons (#1148), as compact noun phrases
  // ("resting HR 62 bpm (up from ~54)"), rendered as a secondary "Also: …" line on the
  // rest card + the Telegram rest nudge so a single snooze can never bury an
  // under-recovery signal the user never saw. Set ONLY on a rest recommendation when
  // more than one signal fires; the salience-ordered primary stays in title/detail.
  // Absent when a single reason fires (byte-for-byte the prior single-reason output).
  also?: string[];
  // The ids of ALL firing under-recovery signals behind a rest recommendation (#1148),
  // in salience order — carried so the "Training anyway" action (#1150) can record the
  // exact set of signals the user acknowledged. Set only on a LIVE rest rec; absent on
  // the acknowledgment card and every non-rest rec.
  firingReasonIds?: string[];
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
// day 2 reads as a persisting recommendation ("… — 2nd day") instead of a fresh
// alert. It counts days the NUDGE fired, not days the user actually rested, so the
// phrasing describes signal persistence, never assumed rest behavior (#752). Stored per-profile
// (JSON in profile_settings), maintained the way the refill nudge dedups an
// episode: opened when a rest rec first fires, carried forward while it keeps
// firing on consecutive days, cleared the moment no rest rec fires.
export interface RestEpisode {
  startDate: string; // first day of the current consecutive rest run (YYYY-MM-DD)
  lastDate: string; // most recent day a rest rec fired — for consecutive-day detection
  reasonId: string; // the rest rec id that last (re)marked the episode
}

// The "Training anyway" acknowledgment (#1150): a per-day declaration of intent —
// "I've decided to train despite this rest recommendation" — DISTINCT from the #39
// snooze (an acknowledgment is not a dismissal, so it never reuses the snooze key).
// When its `date` matches today the rest slot transforms IN PLACE into calm,
// recovery-aware training guidance naming every firing signal, instead of hiding.
// Today-only: a stale (past-date) marker is ignored, so a still-firing physiological
// signal re-evaluates fresh tomorrow and can never be silenced for good. Stored
// per-profile (JSON in profile_settings), the way the rest episode marker is.
export interface RestAck {
  date: string; // the day the user acknowledged training-anyway (YYYY-MM-DD)
  reasonIds: string[]; // firing rest reason ids at ack time — the signals acknowledged
}

export interface CoachingInput {
  today: string; // profile-tz YYYY-MM-DD
  routine: RoutineTargetProgress[];
  strength: StrengthRecent[];
  cardio: CardioRecent[];
  // Distinct dates (YYYY-MM-DD) the profile logged any activity. Still the base
  // "did I move" set (empty-state gate, weekly-recap movement streak); the load
  // triggers no longer key on it directly (see loadingDates).
  trainingDates: string[];
  // Distinct dates (YYYY-MM-DD) that count as LOADING — a hard/intense session that
  // accumulates fatigue, as opposed to an easy recovery activity (issue #754). The
  // consecutive-day / weekly-load overtraining triggers consume THIS instead of every
  // logged activity day, so a light Zone 2 spin doesn't extend a "training streak"
  // the way a max session does. Built by the gather from the pure isLoadingDay
  // classifier (HR-zone split → duration floor → unknown ⇒ loading). Absent ⇒ the
  // triggers fall back to trainingDates (the prior intensity-blind behavior).
  loadingDates?: string[];
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
  // The profile's active routine (#740), threaded through the ONE gather so the
  // dashboard/overview cards and the Telegram nudge all render today's resolved
  // routine session by construction. Absent / null ⇒ the prior no-routine behavior.
  activeRoutine?: ActiveRoutineInput | null;
  // Whether the active routine's mesocycle says TODAY is a deload week (#741),
  // resolved once by getRoutineCycleStatus and threaded through this ONE gather so
  // every surface phrases the deload identically. Absent / false ⇒ non-deload.
  deloadWeek?: boolean;
  sleep: SleepSignal | null;
  restingHr: RestingHrSignal | null;
  // The persisted rest episode as of the last reconcile (null when none is open).
  // Used only to PHRASE a continuing rest nudge — it never changes whether rest
  // fires, only how it reads. Absent ⇒ every rest nudge is phrased fresh (prior
  // behavior).
  restEpisode?: RestEpisode | null;
  // The "Training anyway" acknowledgment for TODAY (#1150), read from the per-profile
  // marker. When its date === today the rest slot renders calm training guidance rather
  // than a rest nudge. Absent/null (or a past-date marker) ⇒ a rest nudge as usual.
  restAck?: RestAck | null;
  // The easy/hard training-intensity split over a trailing window (issue #159),
  // or null when there's no HR zone model / no windowed HR. Drives the hard-heavy
  // "add easy Zone 2" nudge — the classic self-coached polarization failure.
  intensity?: PolarizedSplit | null;
  // Situation-aware coaching context (issue #837): the open flagged-illness episode
  // state + the most-recently-closed episode, from the ONE illness_episodes
  // derivation (#856) the illness surfaces use — never a second engine. During an
  // open episode the go-train / gap / pace nags are HELD; on close a one-shot
  // ease-back rec replaces them for a short ramp. Absent/null ⇒ normal coaching (the
  // prior behavior). It alters what FIRES, never the recovery/safety advice itself.
  illness?: IllnessCoachingContext | null;
  // User-declared injury constraints (#838), NON-resolved only — threaded through this
  // ONE gather so the dashboard/overview cards and the Telegram nudge all exclude active
  // regions + temper recovering ones by construction (#221). Absent / empty ⇒ no injury
  // context (the prior behavior).
  injuries?: InjuryConstraint[];
  // Curated condition→training CONSIDERATION notes (#666) for the profile's ACTIVE mapped
  // conditions — informational, never gating/re-ranking. Threaded through so the note
  // rides the same recommendation everywhere. Absent / empty ⇒ nothing.
  considerations?: ConditionConsideration[];
  // The plan-aware cardio ARM for the soonest active endurance plan (#839) — pre-computed
  // by the gather (which applies the illness pause, #837). Threaded through so the
  // dashboard widget + Telegram render the same note the Training overview does. Absent /
  // null ⇒ no active plan (or held by illness).
  endurancePlanArm?: EnduranceArm | null;
  // Whether the profile is CURRENTLY mid-workout per derived presence (#921). Used
  // ONLY to pick the rest recommendation's TENSE — while a session is live the card
  // softens to next-session framing instead of contradicting reality by saying
  // "rest today". Never changes whether rest fires or its trigger logic. Absent ⇒
  // false (the prior "today" phrasing when no session has happened yet).
  workoutActive?: boolean;
  weightUnit?: WeightUnit; // for the next-set target text; default "kg"
  thresholds?: Partial<CoachingThresholds>;
}

// ---- Situation-aware coaching (issue #837) ----
//
// The transient member of the context taxonomy (#666): during an app-tracked
// illness episode, holding a "you're behind on legs" nag is context, not medical
// judgment — the recommendations themselves are unchanged, only whether they FIRE.
// The state is read from the ONE illness_episodes derivation (#856); the pure
// decision below is what every coaching surface (dashboard card, Telegram nudge)
// keys on, so they can't drift (#221).

// How many days after an episode closes the ease-back re-entry rec replaces the
// immediately-resumed gap nags — a short ramp, then normal coaching resumes. Day 0
// is the close day (first well day); the window is [0, EASE_BACK_RAMP_DAYS).
export const EASE_BACK_RAMP_DAYS = 3;

export interface IllnessCoachingContext {
  // An open flagged-illness episode currently covers today → hold coaching nags.
  openEpisode: boolean;
  // The most-recently CLOSED flagged-illness episode (its stable row id + its
  // exclusive end / first-well day, YYYY-MM-DD), for the ease-back ramp. Null when
  // the profile has never had a closed episode. Ignored while openEpisode is true.
  lastClosed?: { episodeId: number; endDate: string } | null;
}

// Whether coaching is normal, HELD (open episode), or in the post-close EASE-BACK
// ramp — plus the closing episode's id (for the notify one-shot marker) when in the
// ramp. Pure; the same decision the dashboard card and the tick both consume.
export type IllnessCoachingMode = "normal" | "held" | "ease-back";

export function illnessCoachingMode(
  ctx: IllnessCoachingContext | null | undefined,
  today: string
): { mode: IllnessCoachingMode; easeBackEpisodeId: number | null } {
  if (!ctx) return { mode: "normal", easeBackEpisodeId: null };
  if (ctx.openEpisode) return { mode: "held", easeBackEpisodeId: null };
  if (ctx.lastClosed) {
    const ago = daysSince(ctx.lastClosed.endDate, today);
    if (ago >= 0 && ago < EASE_BACK_RAMP_DAYS)
      return { mode: "ease-back", easeBackEpisodeId: ctx.lastClosed.episodeId };
  }
  return { mode: "normal", easeBackEpisodeId: null };
}

// The calm "coaching is paused while you recover" note shown in place of the held
// gap nags during an open episode (issue #837). Neutral tone (not an alert), and it
// carries the structured #656 reason so a surface can render the "why it's quiet".
export function illnessHeldNote(): Recommendation {
  return {
    id: "illness-hold",
    kind: "illness",
    title: "Recovery mode — coaching paused",
    detail:
      "You have an open illness episode, so routine training nudges are paused. Rest and recover first — normal coaching resumes once you're better.",
    tone: "neutral",
    reasons: [coachingHeldReason("Held — illness episode open")],
  };
}

// The one-shot ease-back re-entry recommendation on episode close (issue #837).
// Informational per house style — a light session or easy Zone 2 as a re-entry, not
// a push to resume full volume. Shown on read surfaces through the ramp window; the
// notify tick fires it once (marker per episode id).
export function easeBackRecommendation(): Recommendation {
  return {
    id: "illness-ease-back",
    kind: "illness",
    title: "Ease back in after being sick",
    detail:
      "Back from being sick — a light session or an easy Zone 2 is a good re-entry; volume can wait a few days.",
    tone: "positive",
    actionHref: "/training",
    actionLabel: "Plan a light session",
  };
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

// The rest recommendation's TENSE (#921): saying "rest today" is stale advice once
// today's session already happened (or is happening). Phrasing only — the trigger
// logic/thresholds/episode continuity are untouched, and "today" stays byte-for-byte
// the prior copy so nothing downstream shifts when no session has occurred.
//   • "today"  — no session logged today yet: the original advice.
//   • "next"   — today's session already happened: frame the NEXT session.
//   • "active" — a session is live right now: don't contradict it; frame the next.
type RestTense = "today" | "next" | "active";

// Tense selection (#921): a live session wins (active), else a session already logged
// today reframes to the next session, else the original "today" advice. An active
// session has been auto-saved, so it's also in trainingDates — check active FIRST.
function restTenseFor(input: CoachingInput): RestTense {
  return input.workoutActive
    ? "active"
    : input.trainingDates.includes(input.today)
      ? "next"
      : "today";
}

function restTitle(tense: RestTense): string {
  switch (tense) {
    case "active":
      return "Take it easy — make your next session light";
    case "next":
      return "Make your next session an easy one";
    default:
      return "Rest or take it easy today";
  }
}

// One firing under-recovery signal behind a rest recommendation (#1148). The engine
// checks every trigger (sleep → resting HR → overtraining/load) and collects ALL
// firing ones — not just the first — so the card/nudge can NAME concurrent signals
// and a single snooze can't silently bury one the user never saw. `reasonCore` +
// `todayTail` compose the primary detail (the salience-ordered first reason); `also`
// is the compact noun phrase for the secondary "Also: …" line and the "Training
// anyway" acknowledgment listing.
export interface RestReason {
  id: string; // "rest-sleep" | "rest-rhr" | "rest-overtraining" | "rest-load"
  reasonCore: string;
  todayTail: string;
  also: string;
}

// Compose a rest rec's detail from its reason core and the tense. `todayTail` is the
// exact prior trailing clause, preserved verbatim for the "today" tense; the other
// tenses swap in next-session framing.
function restDetail(
  reasonCore: string,
  todayTail: string,
  tense: RestTense
): string {
  return tense === "today"
    ? `${reasonCore}${todayTail}`
    : tense === "next"
      ? `${reasonCore} — make your next session an easy one to recover.`
      : `${reasonCore} — you're training now; make your next session a light one.`;
}

// Every firing rest reason in salience order (sleep → resting HR → overtraining, then
// weekly load only if the streak didn't already fire — the two schedule-derived
// triggers stay mutually exclusive as before, so "trained N days in a row" and
// "trained N of the last 7" never double up). Empty ⇒ no rest recommendation. Pure;
// the caller picks the salience-ordered primary and renders the rest as "Also: …".
export function restReasons(
  input: CoachingInput,
  th: CoachingThresholds
): RestReason[] {
  const { sleep, restingHr, trainingDates, today } = input;
  // The two schedule-derived triggers (overtraining streak, weekly load) key on
  // LOADING days — hard sessions that accumulate fatigue — not every logged
  // activity, so a light recovery day breaks the streak instead of extending it
  // (#754). Falls back to all activity dates when the load-aware set isn't supplied.
  const loadDates = input.loadingDates ?? trainingDates;

  // Routine-aware cadence (#1115 Fix A): the schedule-derived thresholds are lifted to
  // the active routine's PRESCRIBED loading cadence, so a plan that legitimately
  // schedules many consecutive strength days (a 6-day PPL) can't trip a generic 4-day
  // rule — only DEVIATION from the plan (one more consecutive loading day, or a fuller
  // week than prescribed) warrants a schedule-based rest nudge. The physiological
  // triggers (sleep, RHR) are routine-independent. Off a routine, the generic
  // thresholds stand unchanged.
  const cadence = routineLoadingCadence(input.activeRoutine);
  const effConsecutive = cadence
    ? Math.max(
        th.overtrainingConsecutiveDays,
        cadence.maxConsecutiveLoadingDays + 1
      )
    : th.overtrainingConsecutiveDays;
  const effWindowActive = cadence
    ? Math.max(
        th.overtrainingWindowActiveDays,
        Math.min(cadence.loadingDaysPerCycle + 1, th.overtrainingWindowDays + 1)
      )
    : th.overtrainingWindowActiveDays;

  const reasons: RestReason[] = [];

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
      reasons.push(
        belowBaseline
          ? {
              id: "rest-sleep",
              reasonCore: `You slept ${hoursText(sleep.lastNightMin)} last night, below your ~${hoursText(
                sleep.baselineMin
              )} average`,
              todayTail: " — consider a rest or light day.",
              also: `slept ${hoursText(sleep.lastNightMin)} (below your ~${hoursText(
                sleep.baselineMin
              )} average)`,
            }
          : {
              id: "rest-sleep",
              reasonCore: `You slept ${hoursText(sleep.lastNightMin)} last night`,
              todayTail: " — consider a rest or light day to recover.",
              also: `slept ${hoursText(sleep.lastNightMin)} last night`,
            }
      );
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
    reasons.push({
      id: "rest-rhr",
      reasonCore: `Your resting heart rate is ${Math.round(
        restingHr.recent
      )} bpm, up from your ~${Math.round(restingHr.baseline)} bpm baseline`,
      todayTail: " — an easier day will help you recover.",
      also: `resting HR ${Math.round(restingHr.recent)} bpm (up from ~${Math.round(
        restingHr.baseline
      )})`,
    });
  }

  // Overtraining — consecutive LOADING days, or (mutually exclusive) a heavy trailing
  // window of them. currentStreak counts the consecutive-day run; both triggers key on
  // loadDates (hard sessions) so a logged easy recovery day breaks the streak instead
  // of extending it (#754), making the nudge's "a rest or light day" advice actually
  // satisfiable. A streak of N days in a row already implies a full week, so we surface
  // AT MOST one schedule-derived reason (streak takes precedence) — never both, which
  // would double up ("trained 5 days in a row; trained 5 of the last 7 days").
  const streak = currentStreak(today, loadDates);
  if (streak >= effConsecutive) {
    reasons.push({
      id: "rest-overtraining",
      reasonCore: `You've trained ${streak} days in a row`,
      todayTail:
        " — a rest or light day will help you recover and keep progressing.",
      also: `trained ${streak} days in a row`,
    });
  } else {
    const active = activeDaysInWindow(
      loadDates,
      today,
      th.overtrainingWindowDays
    );
    if (active >= effWindowActive) {
      reasons.push({
        id: "rest-load",
        reasonCore: `You've trained ${active} of the last ${th.overtrainingWindowDays} days`,
        todayTail: " — consider a rest or light day.",
        also: `trained ${active} of the last ${th.overtrainingWindowDays} days`,
      });
    }
  }

  return reasons;
}

// Build the rest recommendation from the firing reasons + tense. The salience-ordered
// FIRST reason names the recommendation (title/detail byte-for-byte the prior
// single-reason output); any others ride along as `also` (#1148), rendered as a
// secondary "Also: …" line so a snooze can't bury an unshown signal.
function buildRestRec(reasons: RestReason[], tense: RestTense): Recommendation {
  const [primary, ...others] = reasons;
  const rec: Recommendation = {
    id: primary.id,
    kind: "rest",
    title: restTitle(tense),
    detail: restDetail(primary.reasonCore, primary.todayTail, tense),
    tone: "caution",
    firingReasonIds: reasons.map((r) => r.id),
  };
  return others.length ? { ...rec, also: others.map((r) => r.also) } : rec;
}

// The rest/light recommendation when a strong recovery signal fires, else null. A thin
// wrapper over restReasons (#1148): it emits the salience-ordered primary as the
// headline and carries any concurrent signals on `also`. When exactly one signal fires
// the output is byte-for-byte the prior single-reason recommendation.
export function restRecommendation(
  input: CoachingInput,
  th: CoachingThresholds
): Recommendation | null {
  const reasons = restReasons(input, th);
  if (reasons.length === 0) return null;
  return buildRestRec(reasons, restTenseFor(input));
}

// The stable id of the "Training anyway" acknowledgment card (#1150). Distinct from
// the rest-nudge ids so the card can tell an acknowledged rest slot from a live one
// (and only offer "Training anyway" on the latter).
export const ACKNOWLEDGED_REST_ID = "rest-acknowledged";

// Whether a recommendation is a LIVE rest nudge the user can still acknowledge with
// "Training anyway" (#1150) — a rest rec that isn't already the acknowledgment card.
export function canAcknowledgeRest(rec: Recommendation): boolean {
  return rec.kind === "rest" && rec.id !== ACKNOWLEDGED_REST_ID;
}

// Sentence-case the first letter (the `also` phrases lead lowercase — "slept …",
// "resting HR …", "trained …" — so a listing that opens a sentence reads right).
function capitalizeFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// The "Training anyway" acknowledgment card (#1150): once the user declares intent to
// train despite the rest recommendation, the rest slot transforms IN PLACE from a
// caution nudge into calm, recovery-aware TRAINING guidance — naming EVERY firing
// signal (#1148), not pressing to reverse the choice (tone caution → neutral/calm).
// Today-only; a still-firing physiological signal re-evaluates fresh tomorrow.
export function acknowledgedRestRec(reasons: RestReason[]): Recommendation {
  const signals = reasons.map((r) => r.also).join("; ");
  return {
    id: ACKNOWLEDGED_REST_ID,
    kind: "rest",
    title: "Training today — keep it smart",
    detail: signals
      ? `${capitalizeFirst(
          signals
        )} — keep intensity moderate, trim volume a bit, and prioritize sleep and hydration tonight.`
      : "Keep intensity moderate, trim volume a bit, and prioritize sleep and hydration tonight.",
    tone: "neutral",
  };
}

// ---- Rest-episode continuity (#44 item 3b) ----
//
// A rest nudge that fires several days running should read as one persisting
// recommendation ("Rest or take it easy — 2nd day"), not a fresh alarm each
// morning. That needs a tiny bit of memory — the persisted RestEpisode —
// reconciled the same way the refill nudge dedups a low-supply episode: a rest rec
// (re)marks it, a day with no rest rec clears it. These pure functions own the
// state machine and the phrasing; the DB read/write lives in
// lib/queries/coaching.ts + the notify tick.

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

// An ordinal numeral ("2nd", "3rd", "11th", "21st") for the continuity phrasing.
function ordinalNumeral(n: number): string {
  const rem100 = n % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13
      ? "th"
      : n % 10 === 1
        ? "st"
        : n % 10 === 2
          ? "nd"
          : n % 10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}

// Re-phrase a rest recommendation as day N (N ≥ 2) of a persisting recommendation.
// The day count is a SUFFIX on whatever tense-aware stance #921 already set on the
// title (#1149) — continuity appends the count, it never re-stances (#221: the tense
// is the single source of the title stance). So a user who trained through yesterday's
// nudge keeps the "Make your next session an easy one — 2nd day" framing instead of
// being told "Rest or take it easy" after deliberately training. The "today" title's
// trailing " today" is tidied off so it reads "…easy — 2nd day", not "…easy today —
// 2nd day"; that path stays byte-for-byte the prior copy.
//
// The detail describes what is actually known — that the recovery SIGNALS have
// persisted — never that the user rested (the episode counts days the nudge fired,
// not days the user complied) (#752). When the tense clause already carries the "keep
// it light"/"make your next session easy" guidance (next/active tense), the continuity
// clause folds to just the persistence FACT so the advice isn't doubled (#1149); the
// "today" tense keeps the full clause unchanged. id/kind/tone/also are preserved, so
// snooze dedup, the caution styling, and the concurrent-reason list are unchanged.
export function withRestContinuity(
  rec: Recommendation,
  day: number
): Recommendation {
  // The "today" tense is the only title ending in " today" (#921 restTitle); the
  // next/active stances read as future-session framing already. Only the "today"
  // path keeps the full "keep it light" continuity clause (byte-for-byte prior copy).
  const isToday = rec.title.endsWith(" today");
  const baseTitle = isToday ? rec.title.slice(0, -" today".length) : rec.title;
  const persistence = `Recovery signals have persisted for ${day} days`;
  return {
    ...rec,
    title: `${baseTitle} — ${ordinalNumeral(day)} day`,
    detail: isToday
      ? `${rec.detail} ${persistence} — keep it light and let recovery catch up.`
      : `${rec.detail} ${persistence}.`,
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
  exercises: string[] = [],
  // Recovering-injury tempering (#838): when the lead exercise's region is returning from
  // a recovering injury, back the next-set target off to RECOVERING_LOAD_FACTOR (a
  // suggestion, never a lockout) so the compact card agrees with the model everywhere.
  tempered = false
): Recommendation {
  const base = suggestNextSet(exercise, wu);
  // Route through the ONE shared modifier composition (#1115 Fix B) so this card and
  // every other next-set surface can't disagree. This path carries only the injury
  // temper (routine-gap/habit strength isn't deload-gated).
  const nextSet = contextualNextSet(base, exercise.exercise, {
    recoveringRegion: tempered,
    recoveringFactor: RECOVERING_LOAD_FACTOR,
  });
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

// Resolve the rest slot's card for today from the live rest recommendation. Two
// day-scoped transforms sit in front of the raw nudge, both keyed to `input.today`:
//   1. "Training anyway" acknowledgment (#1150) — when the user declared intent to
//      train despite the rest rec, the slot becomes calm recovery-aware TRAINING
//      guidance naming every firing signal (#1148), NOT a rest imperative. Wins over
//      continuity: an acknowledged day isn't phrased as "day N of resting".
//   2. Episode continuity (#44 3b) — day 2+ of a persisting rest run reads as
//      "… — 2nd day" with tense-aware phrasing (#1149), derived from the persisted
//      marker + today.
// Pure over the input; the same decision the dashboard card and the Telegram nudge run.
function restCard(
  input: CoachingInput,
  th: CoachingThresholds,
  rest: Recommendation
): Recommendation {
  if ((input.restAck?.date ?? null) === input.today) {
    return acknowledgedRestRec(restReasons(input, th));
  }
  const episode = nextRestEpisode(input.restEpisode ?? null, rest, input.today);
  const day = episode ? restEpisodeDay(episode, input.today) : 1;
  return day >= 2 ? withRestContinuity(rest, day) : rest;
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

  // Situation-aware hold (issue #837): during an open flagged-illness episode — or
  // the short ease-back ramp right after it closes — the go-train / gap / pace nags
  // are HELD. Rest + safety are untouched (rest still fires and leads, so its
  // continuity marker keeps advancing), and this alters what FIRES, never what's
  // advised. The dashboard card and the Telegram nudge both read this one decision.
  const illness = illnessCoachingMode(input.illness, input.today);
  if (illness.mode !== "normal") {
    const ranked: Recommendation[] = [];
    if (rest) ranked.push(restCard(input, th, rest));
    // Ease-back replaces the resumed gap nags for the ramp window; during the open
    // episode a calm held note explains the quiet (carrying the #656 reason).
    ranked.push(
      illness.mode === "ease-back"
        ? easeBackRecommendation()
        : illnessHeldNote()
    );
    return ranked;
  }

  // Build the training-side recommendations (cardio gap, strength gap, on-track,
  // or a habit-based/setup fallback).
  const training = trainingRecommendations(input, wu);

  // A hard-heavy intensity distribution is context, not a top-line alert: it rides
  // along as a trailing secondary note (classifyPolarization is the gate).
  const intensity = intensityRecommendation(input.intensity);

  const ranked: Recommendation[] = [];
  if (rest) {
    // Episode continuity (#44 3b) / "Training anyway" acknowledgment (#1150), both
    // day-scoped transforms in front of the raw nudge — see restCard. Continuity is
    // derived purely from the persisted marker + today, so it's robust even if the
    // marker hasn't been advanced yet today (the notify tick owns the write).
    ranked.push(restCard(input, th, rest));
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
  const recs = nw.items.map((item) =>
    formatWorkoutItem(item, nw, input.today, wu)
  );
  // Calm context notes (#666/#838) ride on the TOP training rec so the dashboard widget
  // and Telegram render the same disclosure/consideration text the Training overview does
  // (one computation, #221). Attached only to the lead card to avoid duplication.
  const notes = contextNotes(nw);
  if (notes.length && recs[0]) recs[0] = { ...recs[0], notes };
  return recs;
}

// The calm context lines for a next-workout result: the active-injury exclusion
// disclosures (#838, "Avoiding Chest (right shoulder injury)") followed by the curated
// condition consideration notes (#666). Pure formatter over the model's data.
export function contextNotes(nw: NextWorkout): string[] {
  const notes: string[] = [];
  for (const d of nw.excludedRegions)
    notes.push(`Avoiding ${excludedRegionLabel(d)}`);
  for (const c of nw.considerations) notes.push(c.note);
  // The plan-aware cardio arm (#839) rides last — a calm forward-looking note, not a
  // constraint. Suppressed at the gather during an open illness episode (#837).
  if (nw.endurancePlanArm) notes.push(nw.endurancePlanArm.note);
  return notes;
}

// Whether an exercise's region is returning from a RECOVERING injury (#838), so its target
// is tempered. Pure over the model's temperedRegions.
function regionTempered(exerciseName: string, nw: NextWorkout): boolean {
  const r = regionForExercise(exerciseName);
  return r != null && nw.temperedRegions.includes(r);
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
    if (item.reason === "routine-day") {
      // A cardio-focus routine day. Copy leads with the day label; the picked
      // activity (if any) is a suggestion, never a hard requirement.
      const label = nw.session?.label ?? "Cardio";
      const a = item.activity;
      return {
        id: "routine-day-cardio",
        kind: "cardio",
        title: label,
        detail: a
          ? `Today's session — ${a.activity} (last done ${formatRelativeDate(
              a.lastDate,
              today
            )}).`
          : "Today's session — log a cardio activity.",
        tone: "action",
        actionHref: "/training",
        actionLabel: "Log this session",
      };
    }
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
    if (item.reason === "routine-day") {
      // A strength routine day. Title is the day label ("Push"); the body lists
      // the filled slate; the target line seeds off the lead lift when it has
      // history (absent ⇒ cold start, shown with reps only). The dedicated
      // Training-overview "Today's session" card renders the per-slot detail;
      // this card is the compact dashboard/rollup form of the same result.
      const label = nw.session?.label ?? "Today's session";
      const deload = nw.session?.deloadWeek ?? false;
      const rawNext = item.exercise ? suggestNextSet(item.exercise, wu) : null;
      // Recovering-injury tempering (#838) + deload week (#741) through the ONE shared
      // composition (#1115 Fix B): temper-then-deload so a lift that is both gets the
      // lighter stacked result, and this compact card agrees with the Training-overview
      // session card, the live logger, the detail panel, and the Telegram nudge.
      const nextSet = item.exercise
        ? contextualNextSet(rawNext, item.exercise.exercise, {
            recoveringRegion: regionTempered(item.exercise.exercise, nw),
            recoveringFactor: RECOVERING_LOAD_FACTOR,
            deloadWeek: deload,
          })
        : rawNext;
      const list = nw.exercises.join(", ");
      const prefix = deload ? "Deload week — " : "";
      return {
        id: "routine-day-strength",
        kind: "strength",
        title: label,
        detail: list
          ? `${prefix}today's session — ${list}.`
          : `${prefix}today's session.`,
        tone: "action",
        actionHref: "/training",
        actionLabel: "Log this session",
        ...(nextSet ? { target: nextSetText(nextSet, wu) } : {}),
        ...(nw.focus.length ? { focus: nw.focus } : {}),
        ...(nw.exercises.length ? { exercises: nw.exercises } : {}),
      };
    }
    if (item.reason === "routine-gap") {
      const t = item.target!;
      const label = frequencyScopeLabel(t.scopeKind, t.scopeValue);
      const remaining = Math.max(0, t.perWeek - t.count);
      const reason = `${t.count} of ${t.perWeek} ${label} ${pluralSessions(
        t.perWeek
      )} this week — ${remaining} to go.`;
      return item.exercise
        ? strengthExerciseRec(
            item.exercise,
            wu,
            reason,
            nw.focus,
            nw.exercises,
            regionTempered(item.exercise.exercise, nw)
          )
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
      nw.exercises,
      regionTempered(item.exercise!.exercise, nw)
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
