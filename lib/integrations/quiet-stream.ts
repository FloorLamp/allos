// THE quiet-stream predicate (issue #2146) — pure, read-time, no stored state, no DB.
//
// ── The class this exists for: connection-level health, data-level silence ────
//
// A provider can be syncing green while one of its continuous data streams has gone
// silent. Three detectors already watch a connection and NONE of them can see it:
//
//   • #1685 staleness watches the LAST SUCCESSFUL SYNC. The phone is still pushing,
//     so nothing is stale.
//   • `currentlyFailingProviders` needs a RECORDED FAILURE. Nothing failed.
//   • #2097's sleep predicate is MULTI-DAY. This is a same-day intraday gap.
//
// The measured signature: heart-rate minutes stop at 21:05; pushes continue `ok=1`
// every 15–30 min with `inserted=0` for that stream while phone-sourced daily
// aggregates keep updating; the next morning the profile is missing its only night of
// sleep in eight weeks. Every signal the app had said "healthy".
//
// ── The predicate ────────────────────────────────────────────────────────────
//
//   > the declared continuous stream's FRONTIER has not moved across the last N
//   > successful pushes, and the frontier is older than the stream's declared dip
//   > tolerance.
//
// THE FIRST CLAUSE IS THE DISCRIMINATOR (#2341 item 4). It used to be "the provider
// kept syncing ok in that window", and that clause was true in both the case this
// detects and the case it must not: a push that is merely LATE is still a successful
// push. #2341 measured this pipeline running 30–61 minutes behind the wrist, against a
// 150-minute tolerance, so the silence being thresholded was
// `(minutes off the wrist) + (ingest lag)` — two terms in one number, the second of
// them large. A watch on a wrist behind a slow push still ADVANCES `MAX(ts)` every
// push; a watch on a charger leaves it frozen while pushes keep landing. That is the
// distinction, and it contains no lag term (see lib/stream-frontier.ts).
//
// The two detectors stay disjoint for the same reason they always were, restated in
// the new terms: with the phone off, no push lands, so no observation is recorded, so
// the frontier is never OBSERVED frozen — the STALENESS detector's case (#1685), which
// already owns it and already names it. Continued pushes that carry nothing new are
// the entire evidence that the pipeline is alive and the DEVICE is not.
//
// The dip tolerance survives as a FLOOR on the frontier's own age rather than as the
// decision: two quiet pushes minutes after a shower started must not be announced. It
// now bounds a quantity with no lag term in it.
//
// ── What it deliberately does NOT do ─────────────────────────────────────────
//
// It stores nothing OF ITS OWN (constraint 5). The frontier observation it reads is
// written by the INGEST path, in the transaction that reads the rows it describes —
// this predicate has no marker to set and none to clear, and backfill still heals the
// row retroactively, because a backfilled batch moves `MAX(ts)` forward and the very
// next push therefore records an advance. A detector with a marker of its own would
// need a sweep to un-say something the data had already un-said.
//
// It never SENDS (constraint 4). Heart rate is an observation domain — the user
// committed to nothing, so there is no obligation to hang a send on — which puts this
// in the coaching tier, classes 2/3 only: rendered where the user goes looking, no
// push, no digest line, no `notify_*` marker. The one send in this family is #2161's
// bedtime wear reminder, and it exists only because it is gated on an explicit opt-in
// toggle that is itself the user's consent.
//
// It never LEARNS (constraint 2). The tolerance is a registry declaration with its
// evidence beside it. There is no wear-pattern model here and there must not be one.

import type { ContinuousStreamId, IntegrationId } from "../types";
import { frontierEvidence } from "../stream-frontier";
import { formatSilence } from "./staleness";

/** The facts one (provider, stream) pair presents to the predicate. */
export interface QuietStreamSignals {
  provider: IntegrationId;
  streamId: ContinuousStreamId;
  /**
   * Is the connection in ordinary standing? False when the provider is already
   * carrying a `failing` or `stale` attention row. #2146 constraint 7 / the #1685
   * rule: one row names the cause, so a provider whose whole connection is broken is
   * not ALSO told that one of its streams is quiet.
   */
  providerHealthy: boolean;
  /**
   * Was this stream delivering on the days behind today? The shared #2097/#2146
   * expected-active gate (lib/stream-activity.ts), resolved by the caller over the
   * stream's declared window. A watch put away three weeks ago is not quiet; without
   * this gate it would report every day forever, since the phone keeps syncing.
   */
  expectedActive: boolean;
  /**
   * Minutes since the newest row on the stream, or null when it has never delivered
   * anything for this profile.
   */
  minutesSinceStream: number | null;
  /**
   * How many successful pushes have landed WITHOUT advancing this stream's frontier
   * (#2341), or null when no push has ever been observed against it. This is the
   * discriminator — the whole separation between "the watch is off" and "the pipeline
   * is late", which no threshold on elapsed silence can make.
   */
  syncsSinceAdvance: number | null;
  /**
   * The stream's DECLARED dip tolerance, in whole minutes — since #2341 a FLOOR on the
   * frontier's age, not the decision.
   */
  toleranceMin: number;
  /** Override for tests; defaults to the shared FROZEN_SYNC_EVIDENCE. */
  frozenSyncs?: number;
}

export type QuietStreamSkip =
  /** A reconnect/stopped row already owns this provider (#1685, constraint 7). */
  | "provider-unhealthy"
  /** This stream was not delivering to begin with — nothing was interrupted. */
  | "not-expected-active"
  /** Nothing has ever arrived on the stream: no baseline to be quiet against. */
  | "no-stream"
  /** Silent, but within tolerance — an ordinary dip (shower, charge, workout). */
  | "stream-live"
  /** The last push MOVED the frontier: the device is producing, however late (#2341). */
  | "frontier-advanced"
  /**
   * Not enough pushes have landed against this frontier to call it frozen — one quiet
   * push is jitter, and no push at all is a connection outage, which #1685 owns.
   */
  | "no-recent-sync";

export type QuietStreamVerdict =
  | { quiet: false; skip: QuietStreamSkip }
  | { quiet: true; quietForMin: number };

/**
 * Is this stream quiet right now?
 *
 * The order of the guards is part of the contract: yield to a bigger problem, then
 * check that there was anything to interrupt, then read the data, and only then ask
 * the frontier question — which is the one that decides which detector this outage
 * belongs to, and the one whose signal costs a stored read.
 *
 * STRICTLY LONGER than the tolerance, matching the house freshness doctrine (a
 * reading is stale strictly AFTER its interval): a stream sitting exactly at its
 * tolerance is still within an ordinary dip. #2161's bedtime reminder fires at the
 * boundary instead, and that difference is deliberate — it is asked ONCE, at a slot
 * minute, so waiting one more minute means waiting until tomorrow.
 */
export function quietStreamVerdict(s: QuietStreamSignals): QuietStreamVerdict {
  if (!s.providerHealthy) return { quiet: false, skip: "provider-unhealthy" };
  if (!s.expectedActive) return { quiet: false, skip: "not-expected-active" };
  if (s.minutesSinceStream == null) return { quiet: false, skip: "no-stream" };
  if (s.minutesSinceStream <= s.toleranceMin)
    return { quiet: false, skip: "stream-live" };
  const frozen = frontierEvidence(s.syncsSinceAdvance, s.frozenSyncs);
  if (!frozen.frozen)
    return {
      quiet: false,
      skip: frozen.why === "advanced" ? "frontier-advanced" : "no-recent-sync",
    };
  return { quiet: true, quietForMin: s.minutesSinceStream };
}

/** One quiet stream, with everything its rendered row needs. */
export interface QuietStream {
  provider: IntegrationId;
  streamId: ContinuousStreamId;
  /** Whole minutes of silence, for the duration copy. */
  quietForMin: number;
  /** The last row's instant, canonical UTC — what "since" is derived from. */
  sinceAt: string;
  /** That instant as the profile-local `HH:MM` the copy names. */
  sinceLocalHhmm: string;
  /** The profile-local day the row is being rendered on — the dedupe key's scope. */
  today: string;
}

/** The signals plus the row's copy ingredients, as the DB layer assembles them. */
export interface QuietStreamCandidate extends QuietStreamSignals {
  sinceAt: string | null;
  sinceLocalHhmm: string | null;
  today: string;
}

/**
 * Every quiet stream among the candidates, AT MOST ONE PER PROVIDER.
 *
 * A provider may declare several continuous streams; the surface still gets one row,
 * because "your watch is off" is one fact however many streams it interrupts. The
 * longest-quiet stream wins — it is the one that has been wrong the longest, so it
 * names the earliest honest "since".
 */
export function quietStreams(
  candidates: readonly QuietStreamCandidate[]
): QuietStream[] {
  const best = new Map<IntegrationId, QuietStream>();
  for (const c of candidates) {
    const verdict = quietStreamVerdict(c);
    // A candidate that fires necessarily has a last row (`no-stream` short-circuits
    // above it), so the copy ingredients are present — but they are read defensively
    // rather than asserted, because a null here would otherwise print "since null".
    if (!verdict.quiet || c.sinceAt == null || c.sinceLocalHhmm == null)
      continue;
    const row: QuietStream = {
      provider: c.provider,
      streamId: c.streamId,
      quietForMin: verdict.quietForMin,
      sinceAt: c.sinceAt,
      sinceLocalHhmm: c.sinceLocalHhmm,
      today: c.today,
    };
    const held = best.get(c.provider);
    if (!held || row.quietForMin > held.quietForMin) best.set(c.provider, row);
  }
  return [...best.values()];
}

/**
 * The row's stable identity, DATE-SCOPED (#2146 constraint 5).
 *
 * Nothing dismisses a quiet-stream row today — it stores no side-state and clears
 * itself when data arrives. The key exists so that if a dismissal is ever wanted it
 * rides the existing Upcoming suppression bus rather than growing a table, and so the
 * rendered list has one identity to key on. The profile-local DAY is in the key on
 * purpose: silencing "the watch was off this morning" must not also silence next
 * Tuesday's.
 */
export function quietStreamDedupeKey(s: {
  provider: IntegrationId;
  streamId: ContinuousStreamId;
  today: string;
}): string {
  return `quiet-stream:${s.provider}:${s.streamId}:${s.today}`;
}

/**
 * The row's title. States what is TRUE and what is SURPRISING about it in one line —
 * the connection is fine, which is why nothing else reported this.
 */
export function quietStreamTitle(
  providerName: string,
  streamLabel: string
): string {
  return `${providerName} is syncing, but ${streamLabel} data has stopped`;
}

/**
 * The row's body. Observation, duration, then the stream's declared prompt.
 *
 * `sinceClock` arrives already formatted by the render layer's clock preference
 * (#1163 — models emit time values, one formatter produces the string), so a 12-hour
 * login reads "10:10 AM" and a 24-hour login reads "10:10".
 */
export function quietStreamDetail(args: {
  streamLabel: string;
  sinceClock: string;
  quietForMin: number;
  prompt: string;
}): string {
  return (
    `No ${args.streamLabel} data has arrived since ${args.sinceClock} — ` +
    `${formatSilence(args.quietForMin)} ago. ${args.prompt}`
  );
}
