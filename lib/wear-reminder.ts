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
// owns that observation; N is the stream's DECLARED evidence bar, resolved from the
// registry by the gather and passed in as `frozenSyncs`.
//
// ── The lag term the frontier test still contained (#2560) ────────────────────
//
// N was 2, shared across every stream, and on 2026-08-11 this sent again — at the
// 23:00 attempt of the 22:00 slot, on a night `hr_minutes` shows 60/60 minutes in every
// hour from 22:00 through 05:24. The pipeline satisfied both conditions; the wrist
// satisfied neither. #2422 replaced an elapsed-time quantity with a movement quantity,
// which is better, but the movement quantity is not lag-free either: the watch batches
// into phone Health Connect independently of the exporter's push, so consecutive
// healthy pushes carry nothing new while the watch records every minute. Measured, the
// frontier-advance interval is p90 39 minutes against a 40-minute floor — the two
// conditions co-fire on ONE long batch instead of cross-checking each other.
//
// Every frozen run in 28 days separates cleanly: every clean false positive was k=2,
// every true detection k>=5. The bar moved to 4, and it moved INTO THE REGISTRY, beside
// the floor, because what it measures is this source's delivery chain.
//
// THE CEILING THIS DOES NOT RAISE, stated so it is not rediscovered: on 29 Jul the
// watch was off 21:12–22:28 and no send fired at any N, because a push at 22:08
// delivered 31 minutes of heart rate recorded BEFORE 21:12 and advanced the frontier
// mid-gap. A backlog draining through a real wear gap resets the counter, and raising N
// makes that strictly worse. Nothing about a frontier can fix it.
//
// The floor is DECLARED, not learned (#2146 constraint 2), and since #2341 it is
// declared in the REGISTRY beside the quiet facet's own tolerance
// (`reminder.frontierFloorMin`), not as a constant here. Its value is unchanged at 40
// minutes and its meaning is not: it bounds the frontier's own age, a quantity with no
// lag term in it. At N=4 it is DOMINATED — four quiet pushes is ~64 minutes, so the
// frontier is always well past 40 — and it is kept anyway, because it costs nothing and
// still states the intent. It simply stopped being load-bearing.
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
  /**
   * N — the watched stream's DECLARED `frozenEvidence.syncs`, resolved by the caller.
   * Required since #2560: it used to be an optional override over a shared constant,
   * and a shared constant is how one stream inherits another pipeline's batching.
   */
  frozenSyncs: number;
}

export type BedtimeWearSkip =
  /** The user has not asked for this. Always checked first. */
  | "disabled"
  /** This profile does not wear a device to sleep. */
  | "not-expected-active"
  /** A reconnect item already owns the contact (#1685). */
  | "source-unhealthy"
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
  if (!signals.sourceHealthy) return { send: false, skip: "source-unhealthy" };
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

// ── WHEN THE NEXT PUSH FALSIFIES THE MESSAGE (issue #3027) ───────────────────
//
// On 2026-08-15 this fired at 22:00 on evidence that was correct when read and false
// five minutes later: the watch had been back on the wrist for 42 minutes, and the push
// carrying those minutes landed at 22:05. Both conditions held honestly — four
// consecutive pushes had left the frontier frozen, and it was far past the floor. The
// watch-to-phone-to-Health-Connect hop was simply running ~45 minutes behind.
//
// THE PREDICATE IS NOT WHAT IS WRONG, and this deliberately does not touch it. The
// module's own comment above states the ceiling ("a backlog draining through a real wear
// gap resets the counter, and raising N makes that strictly worse"), and this night is
// that sentence's mirror image — a gap that ENDED before the slot, whose resumed data had
// not been delivered yet. No threshold separates it either.
//
// What is wrong is that the message then STANDS FOREVER as a claim the next ingest push
// falsifies. Its factual clause was true of what Allos held; its premise ("still on the
// charger?") and its prediction ("tonight's sleep won't be recorded") were both false when
// sent and provably false five minutes later. That is #1779's harm pattern in prose, and
// the resolving event — data ARRIVING — is exactly the class the reconcile sweep watches.
//
// So the decision is TWO COMPARISONS, stated here, pure — and the second one is the
// whole reason a first draft of this was WRONG ON EXACTLY THIS NIGHT.
//
// "The frontier is later than the claim" is not "the wrist is on now". The frontier moves
// when data ARRIVES, and the data that arrives carries timestamps EARLIER than now — that
// is the entire premise of the incident. So on the genuine all-night-charger night, two
// stray minutes at 21:06 and 21:07 landing in the 22:05 push (the tail of the pre-gap
// batch, delivered late) are strictly later than a 21:05 claim, and would have rewritten
// the message to say tonight's sleep is being recorded while the watch sat on the
// charger. That is the harm #3027 was filed to remove, produced by its own correction.
//
// The frontier must ALSO HAVE CAUGHT UP TO NOW — within the stream's own declared
// `frontierFloorMin`, the same tolerance the send predicate uses to decide the frontier
// is too young to call quiet. The correction's condition is therefore the exact negation
// of the floor clause that licensed the send: the message may be edited only at an
// instant when the send would now be refused as "stream-live".

export interface WearReminderClaimVerdict {
  /**
   * Does the stream now hold minutes recorded AFTER the instant the message named, AND
   * has it reached the present? Both, or the message stands. False is the genuine
   * all-night charger case — including the one where a late push delivers a couple of
   * minutes recorded BEFORE the message was sent — and that message must never be edited.
   */
  falsified: boolean;
}

/**
 * Does the stream's current frontier falsify a wear reminder that named `claimedAtMs`?
 *
 * STRICTLY LATER, and the strictness is the point: a frontier that has not moved, or has
 * moved only up TO the claimed instant, says nothing new — the message named the newest
 * minute Allos held, so re-reading that same minute is not evidence of a wrist.
 *
 * AND WITHIN `floorMin` OF `nowMs`: the wrist is on NOW only if the stream has minutes
 * from now. A frontier stuck two hours back is a watch that recorded a little more than
 * the message knew and then stopped, which does not make "tonight's sleep won't be
 * recorded" false.
 *
 * The instants are epoch ms and either may be missing (a stream that has never delivered,
 * a claim this profile never recorded); a missing side answers "not falsified", because
 * an edit has to be earned by evidence and absence is not evidence.
 */
export function wearReminderFalsified(
  claimedAtMs: number | null,
  frontierMs: number | null,
  nowMs: number,
  floorMin: number
): WearReminderClaimVerdict {
  if (claimedAtMs == null || frontierMs == null) return { falsified: false };
  if (!Number.isFinite(claimedAtMs) || !Number.isFinite(frontierMs))
    return { falsified: false };
  if (frontierMs <= claimedAtMs) return { falsified: false };
  // `<` rather than `<=`, mirroring the send predicate's floor exactly: the send fires AT
  // the declared minute, so the correction may not.
  return { falsified: nowMs - frontierMs < floorMin * 60_000 };
}

/**
 * The corrected body, for a message the stream has since falsified.
 *
 * IT RESTATES, IT DOES NOT APOLOGISE. The reader does not need to be told the app was
 * wrong; they need the message in their chat to stop saying their night is not being
 * recorded. So it says what happened, in the same voice as the original — a statement
 * about the data (#2097's copy rule).
 *
 * IT NAMES ONLY THE CLAIMED INSTANT, AND THAT IS DELIBERATE. A first draft also named the
 * frontier ("it has recorded through 22:15"), which is a MOVING value: the sweep runs
 * every tick until rollover, so the corrected body changed on each one and the idempotence
 * pin could not hold it — five pushes in an hour produced five edits of the same message,
 * differing only in a wall clock nobody was reading. The claimed instant is fixed at
 * delivery, so this body is computed once and is byte-identical on every later tick; the
 * sweep hashes it, matches, and makes no Telegram call. Correcting once is a property of
 * the SENTENCE here, not of a second marker somebody has to remember to write.
 *
 * AND IT MAKES NO FORWARD CLAIM (#3060 §1). "Tonight's sleep is being recorded" is a
 * statement about a night that has not happened; the no-forward-claims ruling has no
 * exception here. The sentence states what the stream has shown and stops.
 */
export function bedtimeWearCorrectedBody(lastSeenLocalHhmm: string): string {
  return `Your watch picked up again after ${lastSeenLocalHhmm}.`;
}
