// ONE OPEN EPISODE (#5142) — the single reading of "is this still going?"
//
// Four things in this app are episodes a person starts and may never explicitly
// finish: a live practice, a workout draft, a fast, and a night the app is waiting
// to arrive. Each answered "still going?" with its own machine — its own bound, its
// own comparison, its own word for having given up — so every new close rule was
// written into one of them and not the others (#3143 named the practice bound "the
// fasting shape" and then built a second copy of it).
//
// This module is that question asked once. The domains keep their rows and their
// columns; an episode is a READING over them, the way `computeWorkoutPresence`
// already reads `activities`. Nothing new is stored.

import { daysBetweenDateStr, shiftDateStr } from "./date";
import type { LocalDay } from "./temporal-types";

// ── What the reading is over ────────────────────────────────────────────────────

// TWO UNITS, ONE VOCABULARY (#5142). A minute-counted episode's quiet is minutes since
// an epoch instant. A day-counted one's is profile-local DAYS since a stored calendar
// date that has no clock behind it, so its quiet is calendar arithmetic and never a
// count of 1440-minute blocks: ten local days is 240 hours only when no day is 23 or 25
// hours long, and this repo keeps an instant and a profile-local day apart on purpose
// (docs/internals/time-model.md). The two halves keep their own bounds table and their
// own arithmetic; what they share is the outcome vocabulary below.
//
// `EpisodeKind` is DERIVED from the two halves rather than declared, so a kind cannot
// exist without an entry in its half's table — deleting one makes that table's
// `satisfies` fail rather than leaving a kind nothing can read. That is its whole job
// today: it has NO reader yet, and it is not dead. Its first reader is the reading that
// renders Training, Period and Fast off one state (#5435), which lands with the day
// reading. Deleting it as unused is how a `Record<EpisodeKind, …>` comes back and a kind
// gets to exist with no bounds.
export type MinuteEpisodeKind = "practice" | "workout" | "fast";
export type DayEpisodeKind = "period";
export type EpisodeKind = MinuteEpisodeKind | DayEpisodeKind;

// TWO MORE THINGS IN THIS APP ARE OPEN EPISODES AND NEITHER IS A KIND HERE. Naming
// them is the point: the next reader will find them and should know they were seen.
//
//   * THE NIGHT THE APP IS WAITING FOR (#2097, #5001). It is an episode by every
//     description above — a thing that started, may never arrive, and needs a bound —
//     but its bound is not a quiet timer. It is an ARRIVAL wait: a measured median lag
//     for the source that will deliver it, a default that only bounds, and a sample
//     gate under which nothing is promised. `lib/arrival-wait.ts` is that model, and
//     forcing it into `staleMin` would throw away the measurement, which is the only
//     interesting thing about it.
//
//   * THE STALE ILLNESS EPISODE (#859, `lib/stale-episode.ts`). Same question, same
//     suggest-only discipline, and it even has the same shape of bound —
//     `DEFAULT_STALE_QUIET_DAYS = 3` is a quiet threshold like every `staleMin` here.
//     It is not wired for two reasons. Its quiet is counted in profile-local DAYS from
//     a last-activity DATE, not in minutes from an instant, because a caregiver logging
//     a temperature at 23:55 and again at 00:05 has logged on two days and not ten
//     minutes apart; and its close is a BACKDATED end at the last activity day that
//     only the caregiver may accept, so it has no `abandonMin` at all — the app never
//     gives up holding an illness open. The days question is now settled — this model
//     speaks days as well as minutes (see `EPISODE_DAY_BOUNDS`) — but the illness bound
//     is still not a kind here: `DEFAULT_STALE_QUIET_DAYS` is a per-CALL threshold, so
//     admitting it means the table carrying a per-profile bound. That is its own
//     question, not a debt this model already owes.

// A minute-keyed episode: the kind is narrowed to the minute half because
// `episodeState` reads `EPISODE_BOUNDS` by it, and because that is what this shape has
// always been — `lastSignalAt` is an epoch instant a day-counted episode never has.
export interface OpenEpisode {
  kind: MinuteEpisodeKind;

  // THE FRESHEST EVIDENCE THIS EPISODE IS STILL HAPPENING, as an epoch instant.
  //
  // Not the start, and that is the correction this model makes to the spec's shape.
  // A practice and a fast produce no evidence after their first tap, so their
  // freshest evidence IS the start and the bound has always run from it. A workout
  // draft bumps `updated_at` on every set (#451), so its bound has always run from
  // the last save — a model keyed on `startedAt` cannot express that, and a model
  // keyed on the last signal expresses all three, with the start being the last
  // signal for two of them.
  //
  // Elapsed-since-start is a display quantity, not a lifecycle one: each domain
  // already computes its own (the dock's "for 47 min", the fast's label, the
  // practice duration the End tap writes), so it does not live here.
  lastSignalAt: number;

  // WHEN THE EPISODE'S OWN RECORD SAYS IT ENDS, if it knows — a usual duration
  // stamped at Start (#5091), a measured trace end (#5113), a wearable session.
  // `null` when nothing but a tap can end it.
  expectedEnd: number | null;
}

// ── The minute bounds, one table for the three minute kinds (AC 4) ──────────────
//
// `staleMin` — quiet past which the episode stops reading as in progress and starts
// reading as "you probably forgot". A SUGGEST: it is what raises "Still going?".
// `abandonMin` — quiet past which the app stops holding the episode open on its own.
// `null` means only the person closes this kind: ending a fast and never fasting are
// different truths and only they know which happened (`lib/fasting.ts`), and workout
// presence never auto-ends a session either — it drops the draft from the dock.
export interface EpisodeBounds {
  staleMin: number;
  abandonMin: number | null;
}

export const EPISODE_BOUNDS = {
  // Six hours is longer than any practice this app is a logger for — a sauna, a
  // meditation, a mobility block — and short enough that a Start tapped in the
  // evening is abandoned before the next morning's page load (#3143). That is the
  // ABANDON bound and it has not moved.
  //
  // NINETY MINUTES IS THE NUDGE, and it is a real window now (#5142 AC 3). Practice
  // used to reach both bounds at once — the moment it stopped reading as in progress
  // was the moment the sweep cleared it — because it had no "Still going?" to send
  // and a suggest nobody sends needs no window to be sent in. Now that it has one,
  // the two numbers answer two questions: ninety minutes of silence is past every
  // practice this app is a logger for, so the question does not interrupt anyone
  // mid-sauna; and it leaves four and a half hours in which the person can answer
  // before the sweep clears the row, so the nudge never races its own deadline.
  //
  // The shorter half of the choice is the moment rule this repo already keeps for the
  // practice recap (#5127): a message about a sauna three hours ago is a bulletin,
  // not a question. Half the abandon bound would have been the tidier ratio and the
  // worse message.
  //
  // It only ever fires on a row with NO history: a practice with a usual duration
  // stamps its own expected end at Start and completes itself there (#5091), so it
  // is finished long before any bound is reached. This is the first sauna, not the
  // hundredth — which is also why the number cannot be derived from the usual.
  practice: { staleMin: 90, abandonMin: 6 * 60 },
  // A genuine live session bumps its auto-save every set, so 45 minutes of silence
  // means it is very likely done (#560). The draft is held for 90 so that `stale` is
  // an observable sub-state the hourly tick can fire inside (#921).
  workout: { staleMin: 45, abandonMin: 90 },
  // 36 h is the top of the commonly-practised extended-fast range — long enough that
  // a real 24 h fast is never nagged, short enough that a forgotten one surfaces the
  // same day. Nothing auto-ends it (#2756).
  fast: { staleMin: 36 * 60, abandonMin: null },
} as const satisfies Record<MinuteEpisodeKind, EpisodeBounds>;

// ── The day bounds, one table for the day kinds (AC 4) ──────────────────────────
//
// `staleDays` — profile-local days of quiet past which the episode stops reading as in
// progress and starts reading as "you probably forgot", exactly as `staleMin` above.
// `abandonDays` — days past which the app stops holding the episode open on its own;
// `null` means only the person closes this kind.
export interface EpisodeDayBounds {
  staleDays: number;
  abandonDays: number | null;
}

export const EPISODE_DAY_BOUNDS = {
  // Ten days: a typical period is 3–7 days, so an open one that has run past ten is far
  // more likely a forgotten "Period ended" tap than three weeks of bleeding (#1682 fix
  // a). Past it the row is left EXACTLY as stored and only the menstrual claim lapses,
  // which is why `abandonDays` is null: a period is SUGGEST-ONLY, and nothing but the
  // person closes it. That null is not a placeholder — it is the same statement the
  // fast's `abandonMin: null` makes, the one that leaves a ten-day fast stale rather
  // than closing it.
  period: { staleDays: 10, abandonDays: null },
} as const satisfies Record<DayEpisodeKind, EpisodeDayBounds>;

// A day-keyed episode. The mirror of `OpenEpisode` above, and the two differences are
// the unit: the freshest evidence is a profile-local DAY rather than an epoch instant,
// and there is no `expectedEnd` — see `DayEpisodeState` for why that absence is the
// model's answer rather than a gap in it.
export interface OpenDayEpisode {
  kind: DayEpisodeKind;

  // THE FRESHEST EVIDENCE THIS EPISODE IS STILL HAPPENING, as a profile-local day.
  // A period is logged as a start date and nothing after it, so its start IS its last
  // signal, exactly as a fast's first tap is (`OpenEpisode.lastSignalAt`).
  //
  // A `LocalDay` rather than the stored text, because that is what makes the quiet
  // below a number rather than a `number | null` with an unreachable arm: a day that
  // came through a validator cannot fail to subtract. The reader mints it where it
  // reads the row.
  lastSignalOn: LocalDay;
}

/**
 * The last day a day-counted episode still reads as running: its last signal plus
 * `staleDays − 1`, the signal day being day 1. THE one expression of a day bound —
 * the cycle domain's menstrual-claim cap is defined through it, so the number and the
 * −1 exist once.
 */
export function dayEpisodeClaimEnd(
  kind: DayEpisodeKind,
  lastSignalOn: string
): LocalDay {
  return shiftDateStr(lastSignalOn, EPISODE_DAY_BOUNDS[kind].staleDays - 1);
}

// ── The day reading ─────────────────────────────────────────────────────────────
//
// THE SAME OUTCOME VOCABULARY AS `EpisodeState`, IN DAYS, AND ONE ARM SHORTER.
//
//   running   — inside its bounds, and the app expects more of it.
//   stale     — past `staleDays`. STILL OPEN: every resolution the person had is still
//               offered. A suggest never takes an answer away.
//   abandoned — past `abandonDays`. Unreachable for `period`, whose `abandonDays` is
//               null; the arm exists because the bounds table admits the number, and a
//               day kind that carries one must not have to invent a word for it.
//
// THERE IS NO `finished`, AND THAT IS AN ANSWER RATHER THAN AN OMISSION (#5142, settled
// against the first consumer — Home's Period row, #5435). A minute episode reaches
// `finished` through `expectedEnd`: the row knew its own end — a usual duration stamped
// at Start, a measured trace end, a wearable session — so the reading can report an end
// no sweep got around to writing. A day-counted episode has no such supplier. Nothing
// in this app predicts the day a period will end; the only thing that ends one is the
// person's tap, and that tap writes `period_end`, at which point the row is a CLOSED
// period and there is no open episode left to ask about.
//
// So the closed case is carried by the ABSENCE of an `OpenDayEpisode`, not by a fourth
// arm, and Home renders it the same way: a closed period contributes no state row (a
// row earns its seat by being an open episode or an eligible action, #5435 §2), and the
// forecast-window offer that does render on such a day is a claim about the CYCLE, not
// a reading of a finished episode. A `finished` arm here would be a word for a state
// this half of the model can never observe.
export type DayEpisodeState =
  | { kind: "running"; quietDays: number }
  | { kind: "stale"; quietDays: number }
  | { kind: "abandoned"; quietDays: number };

/**
 * Is this day-counted episode still going, on the profile-local day `on`?
 *
 * The signal day is day 1, so quiet is the days ELAPSED since it and the comparison
 * convention is the minute half's: reaching the bound raises the suggest, and the
 * episode must pass `abandonDays` before the app gives up.
 */
export function dayEpisodeState(
  episode: OpenDayEpisode,
  on: LocalDay
): DayEpisodeState {
  const bounds = EPISODE_DAY_BOUNDS[episode.kind];
  const quietDays = daysBetweenDateStr(episode.lastSignalOn, on);
  if (bounds.abandonDays != null && quietDays > bounds.abandonDays)
    return { kind: "abandoned", quietDays };
  // `staleDays − 1` rather than `staleDays`, for the same reason `dayEpisodeClaimEnd`
  // shifts by it: the signal day is day 1 of the episode, so a ten-day bound is
  // outrun on the day AFTER the ninth elapsed day. Written through the claim end so
  // the two readings of one bound cannot drift — the day the row stops reading as
  // running is the day after the last day it still claims.
  return on > dayEpisodeClaimEnd(episode.kind, episode.lastSignalOn)
    ? { kind: "stale", quietDays }
    : { kind: "running", quietDays };
}

// ── The reading ─────────────────────────────────────────────────────────────────
//
// ONE outcome vocabulary for all three, replacing three ways of saying "abandoned":
//
//   running   — inside its bounds, and the app expects more of it.
//   stale     — past `staleMin`. STILL OPEN: every resolution the person had is
//               still offered, and one more ("discard") is added. A suggest never
//               takes an answer away.
//   abandoned — past `abandonMin`. The app gives up holding it open and invents
//               nothing: what was observed is what the row keeps.
//   finished  — the episode knew its own end and that instant has passed.
export type EpisodeState =
  | { kind: "running"; quietMin: number }
  | { kind: "stale"; quietMin: number }
  | { kind: "abandoned"; quietMin: number }
  | { kind: "finished"; endedAt: number };

export function episodeState(episode: OpenEpisode, now: number): EpisodeState {
  // FINISHED IS READ FIRST, AND NO BOUND REACHES IT. A row that knew its own end
  // knew it whether or not anything swept in time to write it — a Start at 06:28 on
  // a 15-minute practice ended at 06:43 even if nothing ran until the evening.
  // Letting the abandonment branch reach it first would discard an end the row
  // already had, which is the same defect one step removed.
  if (episode.expectedEnd != null && now >= episode.expectedEnd)
    return { kind: "finished", endedAt: episode.expectedEnd };

  const bounds = EPISODE_BOUNDS[episode.kind];
  const quietMin = (now - episode.lastSignalAt) / 60_000;

  // ONE COMPARISON CONVENTION, and it is the one all three domains already used:
  // reaching `staleMin` raises the suggest, and the episode must PASS `abandonMin`
  // before the app gives up.
  //
  // Quiet is the only question asked here. Whether an episode's evidence is itself
  // plausible — a start stranded ahead of the clock by a westward timezone edit — is
  // a claim about the ROW, and the domain that stores the row asks it: a practice
  // start is a wall clock on a stored day, a workout draft's last save is a server
  // stamp, and they do not deserve the same tolerance for reading as future.
  if (bounds.abandonMin != null && quietMin > bounds.abandonMin)
    return { kind: "abandoned", quietMin };
  if (quietMin >= bounds.staleMin) return { kind: "stale", quietMin };
  return { kind: "running", quietMin };
}

/** The two states in which the episode is still going: running, or gone quiet. */
export type OpenEpisodeState = Extract<
  EpisodeState,
  { kind: "running" | "stale" }
>;

/**
 * Is this still an episode the app will complete — one a tap, a measurement or a
 * sweep can still resolve? `stale` is open: it has a suggest on it, not a verdict.
 *
 * ONE PREDICATE OVER BOTH UNITS. "Still going" is the question this whole module
 * exists to ask once, and the answer is the same two words in minutes and in days —
 * so a consumer holding a mixed set of episodes (Home's Training, Fast and Period
 * rows, #5435) asks it once rather than switching on the unit first. Generic rather
 * than widened to `EpisodeState | DayEpisodeState`, so the caller keeps the arm it
 * handed in and `quietMin` / `quietDays` survive the narrowing.
 */
export function episodeIsOpen<S extends EpisodeState | DayEpisodeState>(
  state: S
): state is Extract<S, { kind: "running" | "stale" }> {
  return state.kind === "running" || state.kind === "stale";
}
