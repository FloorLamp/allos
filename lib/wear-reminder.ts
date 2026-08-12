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
// The shape is #2146's quiet-stream predicate, at a bedtime-sized floor:
//
//   > the declared continuous stream's FRONTIER has not moved across the last N
//   > successful pushes, and it is older than the declared floor.
//
// THE FIRST CLAUSE IS THE DECISION (#2341). It used to be "the source kept syncing
// ok in that window", and that clause discriminated the CONNECTION, never the wrist: a
// push that is merely late is still a successful push, so it was true both on the
// night a watch sat on a charger and on the night this pipeline simply ran behind.
// What was actually being thresholded was
//
//     now − MAX(stream.ts)  =  (minutes off the wrist) + (ingest lag)
//
// and the second term is not small here — measured at 60.8 and 30.7 minutes at two
// known instants, with #2263's 1223-push census putting the gap at median 16 / p90 34
// / p99 67. On 2026-08-08 this sent at exactly 40 minutes of "silence" while the watch
// was recording continuously; the push carrying those minutes landed five minutes
// after the message. Both terms live in the same range, so no threshold on that
// quantity can separate them, and raising it makes the motivating incident (charger at
// 21:05, slot at 22:00, ~55 minutes) undetectable — it is SHORTER than a worn watch's
// own lag on a slow night. The threshold was not mistuned; the quantity was wrong.
//
// A watch on a wrist behind a slow pipeline ADVANCES the frontier on every push. A
// watch on a charger leaves it FROZEN while pushes keep landing. lib/stream-frontier.ts
// owns that observation; N = 2 pushes is its evidence bar, which at the measured
// 16-minute median cadence is ~30 minutes of evidence, available at the slot minute.
//
// The floor is DECLARED, not learned (#2146 constraint 2), and since #2341 it is
// declared in the REGISTRY beside the quiet facet's own tolerance
// (`reminder.frontierFloorMin`), not as a constant here. Its value is unchanged at 40
// minutes and its meaning is not: it bounds the frontier's own age, a quantity with no
// lag term in it, and it exists so that a watch put down minutes before a late bedtime
// is not announced on the strength of two quiet pushes.
//
// The two detectors stay disjoint exactly as before, restated: with the phone off, no
// push lands, so nothing is ever OBSERVED frozen — that is #1685's connection outage,
// which already owns and names it. Reporting both would be two contacts for one fault.
//
// ── What it deliberately does NOT do ──────────────────────────────────────────
//
// No escalation, no repeat, no second send if ignored. A missed reminder is answered by
// #2146's calm morning row, not by another interruption. It also YIELDS: when the
// source is failing or stale, a reconnect item already owns the contact and "put your
// watch on" would be false advice while the pipeline is down.
//
// Hourly grain is accepted, not hidden: the check runs at the slot minute, so a charger
// placement a few minutes before a late bedtime is missed. #2121's finer ticks and a
// `typicalBedTime` anchor tighten it later; neither is a dependency.

import { GLYPH } from "./notifications/glyphs";
import { frontierEvidence } from "./stream-frontier";

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
   * Is the source in ordinary standing? False when it is failing or stale — the
   * yields-to-bigger-problems rule.
   */
  sourceHealthy: boolean;
  /**
   * The FRONTIER'S OWN AGE in minutes — `now − MAX(stream.ts)` — or null when the
   * stream has never delivered anything for this profile.
   *
   * Kept as a signal, demoted from decision to floor (#2341): it still contains this
   * pipeline's ingest lag and can never say by itself whether the watch is on a wrist.
   */
  frontierAgeMin: number | null;
  /**
   * How many successful pushes have landed WITHOUT advancing the frontier, or null
   * when no push has ever been observed against it (a fresh deploy, a source
   * connected minutes ago). THIS is what separates "the watch is off" from "the
   * pipeline is late" — see lib/stream-frontier.ts.
   */
  syncsSinceAdvance: number | null;
  /**
   * The DECLARED floor on the frontier's age, in whole minutes — the registry's
   * `reminder.frontierFloorMin` for the watched stream, resolved by the caller. Never
   * a constant in this module again (#2341).
   */
  floorMin: number;
  /** Override for tests; defaults to the shared FROZEN_SYNC_EVIDENCE. */
  frozenSyncs?: number;
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
  /** The frontier is younger than the declared floor — too soon to say anything. */
  | "stream-live"
  /**
   * The last push MOVED the frontier (#2341): the watch is producing, however far
   * behind the pushes carrying it are running. This is the skip that the night of
   * 2026-08-08 should have taken.
   */
  | "frontier-advanced"
  /**
   * Not enough pushes have landed against this frontier to call it frozen — one quiet
   * push is ordinary jitter, none at all is a connection outage (#1685's case), and a
   * stream never yet observed has no evidence either way.
   */
  | "no-recent-sync";

export type BedtimeWearVerdict =
  { send: false; skip: BedtimeWearSkip } | { send: true; quietForMin: number };

/**
 * Decide whether tonight's bedtime slot should carry the wear reminder.
 *
 * The order of the guards is part of the contract, not an implementation detail:
 * consent, then applicability, then deference to a bigger problem, then the data —
 * and within the data, the floor before the frontier evidence, so the two conditions
 * that must BOTH hold are reported by the one that is cheapest to establish.
 *
 * The floor is `<`, i.e. it fires AT the declared minute rather than strictly past it
 * (#2146's quiet row uses `>`, deliberately): this question is asked once, at a slot
 * minute, so waiting one more minute means waiting until tomorrow.
 */
export function bedtimeWearVerdict(
  signals: BedtimeWearSignals
): BedtimeWearVerdict {
  if (!signals.enabled) return { send: false, skip: "disabled" };
  if (!signals.expectedActive)
    return { send: false, skip: "not-expected-active" };
  if (!signals.sourceHealthy)
    return { send: false, skip: "provider-unhealthy" };
  if (signals.frontierAgeMin == null) return { send: false, skip: "no-stream" };
  if (signals.frontierAgeMin < signals.floorMin)
    return { send: false, skip: "stream-live" };
  const frozen = frontierEvidence(
    signals.syncsSinceAdvance,
    signals.frozenSyncs
  );
  if (!frozen.frozen)
    return {
      send: false,
      skip: frozen.why === "advanced" ? "frontier-advanced" : "no-recent-sync",
    };
  return { send: true, quietForMin: signals.frontierAgeMin };
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
