import { DEFAULT_WAKE_MINUTES } from "./dashboard-relevance";
import { arrivalWait } from "./arrival-wait";

// The morning waiting window (issue #2097) — ONE pure decision, consumed by the
// dashboard sleep presentation, the /sleep hero and the Now strip, so the three cannot disagree
// about whether the profile is waiting for last night.
//
// THE STATE THIS NAMES. Every morning there is a real, measurable gap: the user is
// awake, the tracker has not pushed last night yet, and the sleep surfaces have
// nothing true to say about last night. On a measured Health Connect profile the
// sleep row arrived 0.3–1.5 h after waking, median ~70 min — so roughly an hour,
// reliably, every day. What rendered in that hour was the most recent RECORDED
// night: dated honestly since #2099's freshness fix, but still a large headline
// duration for a night nobody asked about. "Waiting, and normal" and "you have not
// synced in two days" were rendering identically.
//
// THE RULE THE COPY OBEYS: say what the DATA is doing, never what the reader should
// be doing. That is why the pre-wake state is "Tonight's sleep is still in
// progress" and not a "sleep mode" line about the hour the reader is keeping. Sleep
// is an OBSERVATION domain in the obligation table (docs/internals/findings.md) —
// an observation cannot be missed, so a line about when someone is "usually asleep"
// carries meaning only as an implied *should*. It would also be surveillance-shaped
// in the sense the food-log ruling already uses (content that exists because the
// system noticed what you just did — here, opening the app at 3am). And the app
// cannot know WHY anyone is awake at that hour; the likeliest reasons — insomnia,
// pain, a sick child, a newborn, a night shift — are exactly the ones to be careful
// with. `typicalWakeTime` could not carry the claim anyway: a 28-night median is
// meaningless for the shift workers and new parents it would be greeting.
//
// REACH. This is a RENDERED state and nothing else. Per the attention doctrine the
// system may reduce contact unilaterally but never increase it, and a missing sync
// is not a safety signal — so there is no notification, no digest line, no
// `notify_*` marker, and no stored state at all. Everything below is derived at read
// time from rows that already exist.
//
// NO SECOND FRESHNESS RULE. Whether last night is in hand is `isLastNight`
// (lib/sleep-summary.ts), the predicate #2099 made THE relative-night answer; this
// module takes the boolean and never re-derives it.

export type SleepWaitingKind = "in-progress" | "waiting" | "not-synced";

export interface SleepWaitingState {
  kind: SleepWaitingKind;
  // The headline that REPLACES the older night's figures. Nothing on screen should
  // be a number the reader has to discount; the previous night stays one tap away.
  headline: string;
  // Minute-of-day the night usually lands by, or null when the arrival sample is
  // too thin to quote a median (see MIN_ARRIVAL_SAMPLES).
  etaMinutes: number | null;
  // The source's last sync attempt, for the "hasn't synced" line. Null when the
  // profile has no sync event to name.
  lastCheckedAt: string | null;
}

// The wake anchor when the profile has no `typicalWakeTime` yet (it needs 14 nights
// in the trailing window) is the SAME fallback the Now strip and the wake-aware
// morning notify slot use, so "when does this person's morning start" has one
// answer across the app. Safe here in a way a behavioral claim never would be: the
// anchor only BOUNDS a statement about the data.

// Arrival lag used when the measured median is unavailable — a plain window bound,
// never quoted to the user as an ETA (that needs the real median).
export const DEFAULT_ARRIVAL_LAG_MIN = 90;

// Slack past the expected arrival before the state turns from "waiting" into
// "hasn't synced". The median is a median: half of all mornings are later than it.
export const ARRIVAL_GRACE_MIN = 30;

// The waiting state is BOUNDED, and the bound is the whole difference between an
// informative state and a stuck one. Past this many minutes after the wake anchor,
// the answer stops being "waiting" whatever the measured lag says.
export const MAX_WAITING_WINDOW_MIN = 180;

// How many mornings of measured arrival lag before the ETA may be quoted. It moved to
// lib/arrival-wait.ts with the model (#5001) — it is the MEASUREMENT's gate rather
// than sleep's, and the invariant is one measurement per source and row kind with no
// consumer keeping its own. Re-exported so every reader that already asks this module
// still gets an answer here.
export { MIN_ARRIVAL_SAMPLES } from "./arrival-wait";

// ── the tracking predicate: CONSUMED, not re-derived ────────────────────────
//
// "Is this profile currently sleep-tracking?" is `isSleepTracking`
// (lib/sleep-summary.ts, #2102) — the data-side companion to `isLastNight`, sitting
// beside it because they are two halves of one question: is last night in hand, and
// is it even coming. The morning digest's one-hour deferral asks it too, so there is
// exactly one answer to "has this person stopped" across the app. Nothing here
// re-implements it.
//
// It is checked FIRST and outranks every waiting branch. Without that precedence
// "no last night, past typical wake" is true every morning after someone stops
// wearing their device, and `typicalWakeTime` keeps supplying a wake anchor for
// roughly two more weeks — so the tile would ask every morning for data that is
// never coming, then go quiet for the accidental reason that the anchor ran out.
//
// What this surface DOES decide is what to feed it: only the wake-days a SYNCING
// source recorded (see getSyncedSleepWakeDays). A manual-only sleep logger has
// nothing arriving, and "waiting" for something nobody is sending is exactly the
// message that teaches people to ignore the surface. The digest passes every
// recorded night instead, because deferring a send is a different question from
// promising an arrival.

// ── the state machine ────────────────────────────────────────────────────────

export interface SleepWaitingSignals {
  // `isLastNight(newestWakeDay, todayStr)` — whether last night is in hand. True
  // means there is nothing to wait for and every branch below is skipped.
  hasLastNight: boolean;
  // Minutes since local midnight in the PROFILE's timezone. The caller resolves it
  // once; nothing here reads a clock.
  minutesOfDay: number;
  // `typicalWakeTime(profileId)`, or null below its 14-night gate.
  wakeMinutes: number | null;
  // `isSleepTracking(...)` (lib/sleep-summary.ts) over the profile's SYNCED
  // wake-days — see the note above on why this surface narrows the input.
  tracking: boolean;
  // The measured median arrival lag in minutes, or null under MIN_ARRIVAL_SAMPLES.
  arrivalLagMin: number | null;
  // THE SLEEP SOURCE is not in the failing/stale attention state. A broken
  // connection has its own reconnect path and a different message; saying "waiting"
  // over the top of it would be a message that cannot resolve.
  //
  // The sleep source, and not the ACCOUNT (#2192). This field is about whether the
  // thing being waited for can still arrive, so the caller scopes it to the sources
  // actually recording this profile's sleep (`getSyncedSleepSources`) rather than
  // handing over the account-wide attention list: an expired Strava token says
  // nothing about last night and must not silence the state. Same discipline as
  // `tracking` above — what this surface decides is what to FEED the decision.
  sourceHealthy: boolean;
  // The most recent sync attempt for the sleep source, for the "hasn't synced"
  // detail line. Null when there is none to name.
  lastCheckedAt: string | null;
}

export function sleepWaitingState(
  s: SleepWaitingSignals
): SleepWaitingState | null {
  // Last night is in hand — the ordinary surfaces have something true to say.
  if (s.hasLastNight) return null;
  // The two "nothing is coming" exits, both BEFORE any clock branch: they fall
  // through to what already exists (the dated label, then the four-night stale
  // CTA), which is a reduction in what the system says and needs no new state.
  if (!s.tracking) return null;
  if (!s.sourceHealthy) return null;

  const wake = s.wakeMinutes ?? DEFAULT_WAKE_MINUTES;
  const eta =
    s.arrivalLagMin == null ? null : (wake + s.arrivalLagMin) % (24 * 60);

  // Before the wake anchor, "last night" has not happened yet. Resolves from the
  // clock alone — a profile with no usable typicalWakeTime still gets this state
  // off the default anchor, because the anchor only bounds a statement about data.
  if (s.minutesOfDay < wake) {
    return {
      kind: "in-progress",
      headline: "Tonight's sleep is still in progress",
      etaMinutes: null,
      lastCheckedAt: null,
    };
  }

  // The arrival half is the SHARED model now (#5001): the four constants above stay
  // here as sleep's own parameters, and the window arithmetic they feed is one
  // computation the practice bound reads too. `elapsedMin` is minutes since the wake
  // anchor, which is this surface's origin; the `ready` arm cannot be reached, because
  // the clock branch above already returned for every minute before that anchor.
  const arrival = arrivalWait({
    measuredLagMin: s.arrivalLagMin,
    defaultLagMin: DEFAULT_ARRIVAL_LAG_MIN,
    graceMin: ARRIVAL_GRACE_MIN,
    maxMin: MAX_WAITING_WINDOW_MIN,
    elapsedMin: s.minutesOfDay - wake,
  });
  if (arrival.kind !== "overdue") {
    return {
      kind: "waiting",
      headline: "Waiting for last night's sleep",
      // A CLOCK, not a duration: the model answers in minutes after the origin, and
      // the origin here is the wake anchor. The modulo is the day rollover a late
      // arrival crosses.
      etaMinutes: eta,
      lastCheckedAt: null,
    };
  }

  return {
    kind: "not-synced",
    headline: "Last night hasn't synced",
    etaMinutes: null,
    lastCheckedAt: s.lastCheckedAt,
  };
}

// The secondary line under the headline, or null when there is nothing honest to
// add. Takes the two boundary formatters rather than importing them, so the COPY
// lives here (one wording for all three surfaces) while clock and timestamp shapes
// stay the login's preference.
//
// The in-progress state deliberately has NO detail: anything added there would be a
// remark about the hour, which is the one thing this state must not make.
export function sleepWaitingDetail(
  state: SleepWaitingState,
  fmt: {
    clock: (minutesOfDay: number) => string;
    when: (iso: string) => string;
  }
): string | null {
  switch (state.kind) {
    case "in-progress":
      return null;
    case "waiting":
      return state.etaMinutes == null
        ? null
        : `Usually in by ~${fmt.clock(state.etaMinutes)}`;
    case "not-synced":
      return state.lastCheckedAt == null
        ? null
        : `Last checked ${fmt.when(state.lastCheckedAt)}`;
  }
}
