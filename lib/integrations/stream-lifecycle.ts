// THE continuous-stream ON/OFFBOARDING state machine (issue #2162) — pure, read-time,
// no DB, no clock, no stored state of its own.
//
// ── What was missing ─────────────────────────────────────────────────────────
//
// The quiet-stream family arrived in three pieces that never met: #2146 DETECTS a
// stream that went quiet, #2161 SENDS an opt-in bedtime reminder about it, #2097
// answers "is this person tracking at all". Nothing introduced the reminder when a
// wearable started delivering, and nothing closed the loop when the user stopped
// wearing it. This module is that lifecycle, and it is deliberately built ON TOP of
// what those three already declared rather than beside it:
//
//   • the ENUMERATION is `allContinuousStreams()` — #2146's registry declarations,
//     which already carry the reminder adapter (`reminder: "bedtime-wear"`) and the
//     expected-active window. A source that declares no stream has no lifecycle,
//     by construction, with no exemption list anywhere.
//   • the ACTIVE/LAPSED boundary is `isStreamActive` (lib/stream-activity.ts) over
//     that declared window — the same predicate the quiet row and the reminder ask.
//     There is no second staleness rule here.
//
// ── The states ───────────────────────────────────────────────────────────────
//
//   absent ──▶ appeared ──▶ active ──▶ lapsed ──▶ (data returns ⇒ active) | ended
//
// EVERY state is derived at read time from rows already stored: the first day this
// stream ever delivered, the last day it delivered, and the shared expected-active
// gate. Nothing is written when a state changes, there is no episode table, and a
// backfilled batch heals the answer retroactively because it moves those two days.
// The ONLY side-state in the whole feature is "this offer was shown and answered",
// which rides the existing Upcoming suppression bus (#2146 constraint 5 said the key
// would be there when a dismissal was finally wanted — this is that moment).
//
// `resumed` is not a member of the union, and that is the issue's own shape:
// "resumed ⇒ active". A stream that delivers again IS active; there is no welcome-back
// content and no re-onboarding, because re-opening a derived gate needs no ceremony.
//
// ── Why the order of the guards matters ──────────────────────────────────────
//
// `isStreamActive` deliberately never inspects TODAY (the day under examination is the
// one the caller is asking about, so counting it would make the answer circular), and
// it needs `minDays` of history to say yes at all. Two consequences this module owns:
//
//   1. A stream on its FIRST day has no history to be active by. It must be read as
//      `appeared`, not as `lapsed` — which is why the appeared check runs before the
//      gate rather than after it.
//   2. A stream that delivered TODAY, after a long silence, is active on the strongest
//      possible evidence and the shared window structurally cannot see it. So today's
//      delivery is read here as active outright. That is the whole of "resumed": no
//      new number, no learner, just the one day the shared predicate omits by design.

import { daysBetweenDateStr } from "../date";
import type { ContinuousStreamId, IntegrationId } from "../types";

/**
 * How recently a stream must have STARTED delivering for its arrival to still be the
 * onboarding moment.
 *
 * A fortnight, and it is a property of the PERSON's relationship with a new device
 * rather than of any stream's cadence, which is why it is declared once here instead
 * of per stream in the registry: "I just started wearing this" has the same shape for
 * heart rate, SpO2 or a future continuous glucose feed. A stream that needs its own
 * number becomes an optional facet on its registry entry, the way `quiet` and
 * `reminder` already are — nothing here has to widen for that.
 */
export const STREAM_APPEARED_WITHIN_DAYS = 14;

/**
 * How long a lapse must be sustained before it is read as `ended` and the offboarding
 * prompt is offered.
 *
 * Deliberately WELL PAST the two-to-three days in which the expected-active gate
 * already goes quiet on its own, so the prompt can never race the gate: by the time it
 * appears, the reminders it is explaining have been silent for over a week and the
 * user has had ample opportunity to simply start wearing the device again. The
 * completeness test in lib/__tests__/stream-lifecycle.test.ts asserts this clears
 * every registered stream's declared `expectedActive.windowDays` by a wide margin, so
 * a stream declaring a slow window cannot silently invert the relationship.
 */
export const STREAM_ENDED_AFTER_DAYS = 14;

/**
 * Where a (source, stream) pair sits in its lifecycle, for ONE profile, right now.
 *
 * `absent` is a real member rather than a null: a source connected yesterday that
 * has never delivered a single row is a genuine, nameable state, and it is NOT an
 * onboarding moment — there is nothing yet to offer a reminder about.
 */
export type StreamLifecycleState =
  /** Nothing has ever arrived on this stream for this profile. */
  | "absent"
  /** It started delivering recently — the onboarding moment. */
  | "appeared"
  /** It is delivering, per the shared expected-active gate. */
  | "active"
  /** It was delivering and has stopped, but not for long enough to be over. */
  | "lapsed"
  /** The lapse is sustained past the declared horizon. */
  | "ended";

/** Everything the state machine reads, all of it derived from stored rows. */
export interface StreamLifecycleFacts {
  /** The profile-local day this stream FIRST delivered, or null if it never has. */
  firstDay: string | null;
  /** The profile-local day it delivered MOST RECENTLY, or null if it never has. */
  lastDay: string | null;
  /**
   * The shared #2097/#2146 expected-active gate (`isStreamActive`) over the stream's
   * DECLARED window, resolved by the caller. Never re-derived here — a second
   * staleness rule in this module is exactly the drift #2146 existed to end.
   */
  expectedActive: boolean;
  /** The profile-local day the question is being asked on. */
  today: string;
  /** Test/declaration overrides; both default to the constants above. */
  appearedWithinDays?: number;
  endedAfterDays?: number;
}

/** Whole profile-local days from `day` to `today`, or null on an unreadable day. */
function daysSince(day: string, today: string): number | null {
  return daysBetweenDateStr(day, today);
}

/**
 * Where this stream is in its lifecycle.
 *
 * The guard order is the contract:
 *   1. nothing ever ⇒ `absent`
 *   2. silent past the horizon ⇒ `ended` (a stream that appeared and immediately died
 *      still ends up here, which is why this outranks the appeared check)
 *   3. started recently ⇒ `appeared` (before the gate, because an infant stream has no
 *      history to be active by)
 *   4. delivering TODAY ⇒ `active` (the day the shared window omits by design — this
 *      is what makes a resume need no ceremony)
 *   5. the shared gate ⇒ `active` / `lapsed`
 */
export function streamLifecycleState(
  f: StreamLifecycleFacts
): StreamLifecycleState {
  if (f.firstDay == null || f.lastDay == null) return "absent";
  const sinceLast = daysSince(f.lastDay, f.today);
  const sinceFirst = daysSince(f.firstDay, f.today);
  if (sinceLast == null || sinceFirst == null) return "absent";

  const endedAfter = f.endedAfterDays ?? STREAM_ENDED_AFTER_DAYS;
  const appearedWithin = f.appearedWithinDays ?? STREAM_APPEARED_WITHIN_DAYS;

  if (sinceLast >= endedAfter) return "ended";
  if (sinceFirst <= appearedWithin) return "appeared";
  if (sinceLast <= 0) return "active";
  return f.expectedActive ? "active" : "lapsed";
}

// ── The offers ───────────────────────────────────────────────────────────────

/**
 * Which offer, if any, this stream is presenting right now.
 *
 * `onboard` — "it started delivering; want the bedtime reminder?" Two buttons, and
 * IGNORING IT ENABLES NOTHING: the Yes tap is the only thing that ever writes the
 * #2161 setting (its constraint 1), so opting out means dismissing the offer, never
 * disabling something that was already on. Default-on would be the contact-consent
 * rule (docs/internals/findings.md §2) violated in the one direction it forbids.
 *
 * `offboard` — "the reminders paused themselves; turn them off, or keep them ready?"
 * This is §7's confirm-to-KEEP shape, not a second consent request. The reduction has
 * ALREADY happened, unilaterally and correctly: the expected-active gate closed days
 * ago and the sends stopped by themselves. The prompt explains that and offers the
 * opposite affordance — keep. Ignoring it changes nothing, which is the point: a
 * disengaged user is not nagged, and the setting they own is never rewritten behind
 * their back.
 */
export type StreamOfferKind = "onboard" | "offboard";

export interface StreamOfferSignals {
  state: StreamLifecycleState;
  /** Does this stream declare a send adapter to offer at all? (`reminder` facet.) */
  hasReminder: boolean;
  /**
   * The #2161 setting as the USER declared it — not a derived "will it fire tonight".
   * It is profile-scoped and there is exactly one of it, which is what satisfies the
   * multi-source rule: a second wearable delivering the same stream finds it already
   * true and offers nothing, because the consent has been given and re-asking for it
   * would be noise.
   */
  reminderEnabled: boolean;
  /** Is this stream's PERMANENT onboarding key already suppressed? */
  onboardDismissed: boolean;
  /** Is THIS LAPSE EPISODE's offboarding key already suppressed? */
  offboardDismissed: boolean;
}

export function streamOfferKind(s: StreamOfferSignals): StreamOfferKind | null {
  // A stream with no send adapter has nothing to on- or offboard onto. Its lifecycle
  // still resolves — that is what makes a future adapter a declaration rather than a
  // code change here — it simply presents no offer.
  if (!s.hasReminder) return null;
  if (s.state === "appeared" && !s.reminderEnabled && !s.onboardDismissed)
    return "onboard";
  if (s.state === "ended" && s.reminderEnabled && !s.offboardDismissed)
    return "offboard";
  return null;
}

// ── The keys ─────────────────────────────────────────────────────────────────
//
// Both ride the Upcoming suppression bus (`upcoming_dismissals`), so a dismissal is
// stored exactly where every other dismissal in the app is stored, is visible and
// restorable in Upcoming's "Snoozed & dismissed", and needed no table of its own.
// Their two shapes encode the two one-shot semantics the issue specifies.

/**
 * ONE-SHOT PER (SOURCE, STREAM), FOREVER. Both tails are fixed registry vocabulary,
 * so the key is `catalog`-class: "stop offering me this reminder for my Health Connect
 * heart rate" is a statement about the topic, and outliving any particular row is the
 * intended behaviour. A NEW source or a NEW stream mints a different key, which is
 * the issue's "a new source or stream is a new offer" holding structurally.
 */
export const STREAM_ONBOARD_PREFIX = "stream-onboard:";

/**
 * ONE-SHOT PER LAPSE EPISODE. The tail carries the episode anchor — the last day the
 * stream delivered — which is `anchored`-class: it is constant for the whole of one
 * lapse (so a dismissed prompt never repeats inside it) and a genuine resume moves it
 * (so a fresh lapse afterwards is a fresh offer). No episode row, no sweep, no way for
 * the two halves to disagree about which lapse is which.
 */
export const STREAM_OFFBOARD_PREFIX = "stream-offboard:";

export function streamOnboardKey(
  sourceId: IntegrationId,
  streamId: ContinuousStreamId
): string {
  return `${STREAM_ONBOARD_PREFIX}${sourceId}:${streamId}`;
}

export function streamOffboardKey(
  sourceId: IntegrationId,
  streamId: ContinuousStreamId,
  episodeDay: string
): string {
  return `${STREAM_OFFBOARD_PREFIX}${sourceId}:${streamId}:${episodeDay}`;
}

/** The (source, stream) a lifecycle offer key names, or null for a foreign key. */
export function streamOfferTarget(
  key: string
): { kind: StreamOfferKind; sourceId: string; streamId: string } | null {
  const kind: StreamOfferKind | null = key.startsWith(STREAM_ONBOARD_PREFIX)
    ? "onboard"
    : key.startsWith(STREAM_OFFBOARD_PREFIX)
      ? "offboard"
      : null;
  if (!kind) return null;
  const prefix =
    kind === "onboard" ? STREAM_ONBOARD_PREFIX : STREAM_OFFBOARD_PREFIX;
  const [sourceId, streamId] = key.slice(prefix.length).split(":");
  if (!sourceId || !streamId) return null;
  return { kind, sourceId, streamId };
}

// ── The copy ─────────────────────────────────────────────────────────────────
//
// #2097's rule throughout: STATE THE DATA, never the person. "No heart-rate data has
// arrived in 14 days" is a fact the app can see. "You stopped wearing your watch" is a
// guess about someone's life, and being told a wrong one is how a surface earns being
// switched off. Neither string ever instructs.

export function streamOnboardTitle(
  sourceName: string,
  streamLabel: string
): string {
  return `${sourceName} started sending ${streamLabel} data`;
}

export function streamOnboardBody(streamLabel: string): string {
  return (
    `A bedtime reminder can tell you when ${streamLabel} data has gone quiet before ` +
    `you sleep — a watch left on the charger costs the whole night's sleep, and no ` +
    `later sync recovers it. Off unless you turn it on.`
  );
}

export const STREAM_ONBOARD_ACCEPT = "Yes, remind me";
export const STREAM_ONBOARD_DECLINE = "No thanks";

export function streamOffboardTitle(): string {
  return "Bedtime watch reminders have paused themselves";
}

export function streamOffboardBody(
  sourceName: string,
  streamLabel: string,
  quietDays: number
): string {
  return (
    `No ${streamLabel} data has arrived from ${sourceName} in ${quietDays} days, ` +
    `so the bedtime reminder stopped sending. It starts again on its own if data ` +
    `starts arriving — nothing here has changed your setting.`
  );
}

export const STREAM_OFFBOARD_TURN_OFF = "Turn them off";
export const STREAM_OFFBOARD_KEEP = "Keep them ready";

/**
 * Settings → Notifications honesty (#2162 constraint 5): while the gate is closed, the
 * enabled toggle must not imply a send is coming tonight.
 *
 * It reports the DERIVED pause and leaves the toggle exactly as the user set it — the
 * paused state is presentation, never a stored flag, which is the same shape #1668
 * shipped for the mood check-in's auto-pause.
 */
export function streamReminderPausedNote(
  sourceName: string,
  streamLabel: string,
  quietDays: number
): string {
  return (
    `Paused — no ${streamLabel} data from ${sourceName} for ${quietDays} ` +
    `${quietDays === 1 ? "day" : "days"}. It resumes on its own when data arrives.`
  );
}
