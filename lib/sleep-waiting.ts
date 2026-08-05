import { shiftDateStr } from "./date";
import { DEFAULT_WAKE_MINUTES } from "./now-strip";

// The morning waiting window (issue #2097) — ONE pure decision, consumed by the
// dashboard tile, the /sleep hero and the Now strip, so the three cannot disagree
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
  // The provider's last sync attempt, for the "hasn't synced" line. Null when the
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

// How many mornings of measured arrival lag before the ETA may be quoted.
// `integration_sync_rows` retention reaches back ~12 days on the measured instance,
// so the arrival sample is often thinner than the 14 nights `typicalWakeTime`
// demands — under the gate the copy degrades to the plain wording rather than
// quoting a median built on three mornings.
export const MIN_ARRIVAL_SAMPLES = 5;

// ── the tracking predicate ───────────────────────────────────────────────────
//
// "Is this profile currently sleep-tracking?" — a DATA-side question, and it has to
// be, because the connection-side one cannot answer it. `isStaleSyncEvent` watches
// the CONNECTION's liveness and lib/integrations/staleness.ts is explicit that this
// is deliberate ("a rest week with no activities is not staleness"), so it is
// structurally blind to the abandoned device: watch in a drawer, phone still
// syncing steps, provider green, only the sleep rows stopped.
//
// Left unguarded that failure RECURS rather than resolving — "no last night, past
// typical wake" is true every morning once someone stops, and `typicalWakeTime`
// keeps supplying a wake anchor for roughly two more weeks. The tile would ask
// every morning for data that is never coming, then go quiet for the accidental
// reason that the anchor ran out.
//
// So the predicate is checked FIRST and outranks every waiting branch. Two
// conditions, and they answer different failures:
//
//   1. The night immediately before last night is recorded. The waiting state is
//      about ONE missing night — as soon as the gap is two nights deep, the profile
//      has not "not synced yet", it has STOPPED, and asking again would be the
//      recurrence above. This is what makes the abandoned device produce the
//      waiting state on the FIRST morning and never again.
//   2. At least 2 of the 3 nights before last night are recorded. A profile that
//      records one night in three was never in a daily rhythm to be waiting on.
//
// Together they tolerate a forgotten charge (a hole at T−2 with T−1 recorded stays
// tracking) while stopping after two consecutive misses rather than fourteen.
//
// The days passed in must come from a SYNCING source. A manual-only sleep logger
// has nothing arriving, and "waiting" for something nobody is sending is exactly
// the message that teaches people to ignore the surface.
export const TRACKING_LOOKBACK_NIGHTS = 3;
export const TRACKING_MIN_NIGHTS = 2;

export function isSleepTracking(
  syncedWakeDays: Iterable<string>,
  todayStr: string
): boolean {
  const days = new Set(syncedWakeDays);
  // Wake-day T is last night; the nights BEFORE it are T−1 … T−3.
  const prior = [];
  for (let back = 1; back <= TRACKING_LOOKBACK_NIGHTS; back++) {
    prior.push(days.has(shiftDateStr(todayStr, -back)));
  }
  if (!prior[0]) return false;
  return prior.filter(Boolean).length >= TRACKING_MIN_NIGHTS;
}

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
  // `isSleepTracking(...)` over the profile's synced wake-days.
  tracking: boolean;
  // The measured median arrival lag in minutes, or null under MIN_ARRIVAL_SAMPLES.
  arrivalLagMin: number | null;
  // No provider is in the failing/stale attention state. A broken connection has
  // its own reconnect path and a different message; saying "waiting" over the top
  // of it would be a message that cannot resolve.
  providerHealthy: boolean;
  // The most recent sync attempt for the sleep provider, for the "hasn't synced"
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
  if (!s.providerHealthy) return null;

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

  const window = Math.min(
    (s.arrivalLagMin ?? DEFAULT_ARRIVAL_LAG_MIN) + ARRIVAL_GRACE_MIN,
    MAX_WAITING_WINDOW_MIN
  );
  if (s.minutesOfDay <= wake + window) {
    return {
      kind: "waiting",
      headline: "Waiting for last night's sleep",
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
