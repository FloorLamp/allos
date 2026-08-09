// THE bedtime wear reminder decision (issue #2161) — pure, no DB, no clock.
//
// One send, opt-in, at the profile's Bedtime slot: the watch is off the wrist as
// bedtime approaches, and if it stays there the night's sleep data is simply gone.
//
// ── Why this may be a class-1 send at all ─────────────────────────────────────
//
// Sleep and heart rate are OBSERVATION domains (docs/internals/findings.md §3): the
// user committed to nothing, so there is no obligation to hang a send on, and that is
// exactly why #2146's quiet-stream row is deliberately render-only. The contact-consent
// rule (§2) is the whole basis for this feature:
//
//   > The system may reduce contact unilaterally. It may never increase contact, or
//   > rewrite user-owned state, without the user's consent.
//
// So the consent is the feature, not decoration around it. `enabled` is a user-owned
// declaration — an explicit Settings → Notifications toggle, off by default — in the
// same position `obligation = 'must'` occupies for a medication and a tracked care item
// occupies for follow-up escalation. Two consequences that this module ENFORCES rather
// than merely documents:
//
//   1. OFF IS EXACTLY TODAY'S BEHAVIOUR. `enabled: false` returns before any other
//      signal is looked at. There is no "helpful" first send, no one-time
//      announcement, no degraded variant.
//   2. NOTHING ENABLES IT BUT A TAP. Nothing in this module, in its gather, or in the
//      tick writes the setting. A detected lost night may SUGGEST turning it on
//      (the right-sizing family's shape: detection suggests, the user's tap writes) —
//      it may never perform the write.
//
// ── What the predicate actually asks ──────────────────────────────────────────
//
// The shape is #2146's quiet-stream predicate, at a bedtime-sized tolerance:
//
//   > the declared continuous stream has been silent for ≥ tolerance, WHILE the
//   > provider kept syncing ok in that window.
//
// The second clause is load-bearing and is the whole reason this is not the staleness
// detector's job: continuing ok syncs with nothing arriving on the stream is the
// off-wrist signature (the phone keeps pushing its own aggregates), whereas a window
// with no ok syncs at all is a CONNECTION outage, which #1685 already owns and already
// names. Reporting both would be two rows, and two contacts, for one fault.
//
// Tolerance is DECLARED, not learned (#2146 constraint 2). #2146's 2.5 h dip tolerance
// is tuned to separate routine removals — the measured evening-charge distribution is
// bimodal with an empty valley at 2.1–2.5 h — from real events at any hour. This check
// is not at any hour: it runs once, at the bedtime slot, when a removal that is still
// in effect is about to cost the night. So the tolerance is the much shorter "long
// enough that this is not a shower": ~40 minutes, which the measured incident
// (charger at 21:05, bedtime slot 22:00) clears comfortably.
//
// ── What it deliberately does NOT do ──────────────────────────────────────────
//
// No escalation, no repeat, no second send if ignored. A missed reminder is answered by
// #2146's calm morning row, not by another interruption. It also YIELDS: when the
// provider is failing or stale, a reconnect item already owns the contact and "put your
// watch on" would be false advice while the pipeline is down.
//
// Hourly grain is accepted, not hidden: the check runs at the slot minute, so a charger
// placement a few minutes before a late bedtime is missed. #2121's finer ticks and a
// `typicalBedTime` anchor tighten it later; neither is a dependency.

/** Minutes of stream silence before the watch is presumed off the wrist at bedtime. */
import { GLYPH } from "./notifications/glyphs";

export const WEAR_QUIET_TOLERANCE_MIN = 40;

export interface BedtimeWearSignals {
  /**
   * The user-owned declaration. False is not a filter over a computed answer — it is
   * the answer, and it must be checked first.
   */
  enabled: boolean;
  /**
   * Is this stream expected to be active overnight at all? The shared #2097/#2146
   * vocabulary, resolved by the caller as `isSleepTracking` over the profile's
   * SYNCED wake days: someone who does not wear a device to sleep has nothing to be
   * reminded about, and telling them otherwise every night is how a surface earns
   * being ignored.
   */
  expectedActive: boolean;
  /**
   * Is the provider in ordinary standing? False when it is failing or stale — the
   * yields-to-bigger-problems rule.
   */
  providerHealthy: boolean;
  /**
   * Minutes since the newest row on the declared continuous stream, or null when the
   * stream has never delivered anything for this profile.
   */
  minutesSinceStream: number | null;
  /**
   * Did the provider record at least one SUCCESSFUL sync inside the silent window?
   * This is what separates "the watch is off" from "the phone is off".
   */
  syncedDuringGap: boolean;
  /** Override for tests and for a future per-provider declaration. */
  toleranceMin?: number;
}

export type BedtimeWearSkip =
  /** The user has not asked for this. Always checked first. */
  | "disabled"
  /** This profile does not wear a device to sleep. */
  | "not-expected-active"
  /** A reconnect item already owns the contact (#1685). */
  | "provider-unhealthy"
  /** Nothing has ever arrived on the stream — there is no baseline to be quiet against. */
  | "no-stream"
  /** The stream is live (or was, within tolerance). Nothing to say. */
  | "stream-live"
  /** No successful sync inside the window: a connection outage, not an off wrist. */
  | "no-ok-sync";

export type BedtimeWearVerdict =
  { send: false; skip: BedtimeWearSkip } | { send: true; quietForMin: number };

/**
 * Decide whether tonight's bedtime slot should carry the wear reminder.
 *
 * The order of the guards is part of the contract, not an implementation detail:
 * consent, then applicability, then deference to a bigger problem, then the data.
 */
export function bedtimeWearVerdict(
  signals: BedtimeWearSignals
): BedtimeWearVerdict {
  if (!signals.enabled) return { send: false, skip: "disabled" };
  if (!signals.expectedActive)
    return { send: false, skip: "not-expected-active" };
  if (!signals.providerHealthy)
    return { send: false, skip: "provider-unhealthy" };
  if (signals.minutesSinceStream == null)
    return { send: false, skip: "no-stream" };
  const tolerance = signals.toleranceMin ?? WEAR_QUIET_TOLERANCE_MIN;
  if (signals.minutesSinceStream < tolerance)
    return { send: false, skip: "stream-live" };
  if (!signals.syncedDuringGap) return { send: false, skip: "no-ok-sync" };
  return { send: true, quietForMin: signals.minutesSinceStream };
}

/**
 * The reminder's body, given the profile-local HH:MM of the last recorded minute.
 *
 * It STATES what the data is doing and asks a question — the #2097 copy rule. It does
 * not say "put your watch on", because the app does not know why the watch is off and
 * an instruction would be an implied *should* in a domain that carries no obligation.
 */
export function bedtimeWearBody(lastSeenLocalHhmm: string): string {
  return `Your watch hasn't recorded anything since ${lastSeenLocalHhmm} — still on the charger? Tonight's sleep won't be recorded without it.`;
}

export const BEDTIME_WEAR_TITLE = `${GLYPH.wearable} Heading to bed?`;
