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
//   > the declared continuous stream has been silent longer than its declared dip
//   > tolerance, WHILE the provider kept syncing ok in that window.
//
// THE SECOND CLAUSE IS LOAD-BEARING (#2146 constraint 1). A gap window with NO ok
// syncs is the STALENESS detector's case — the phone is off, not the watch — and
// #1685 already owns it and already names it. Without the clause this row would be a
// second report of one outage, in a second voice, on the same surface. With it, the
// two are disjoint by construction: continued syncs are the entire evidence that the
// pipeline is alive and the DEVICE is not.
//
// ── What it deliberately does NOT do ─────────────────────────────────────────
//
// It STORES NOTHING (constraint 5). There is no marker to set and none to clear:
// backfill heals the row retroactively, because the row is a function of `max(ts)`
// and a backfilled batch moves `max(ts)` forward. A detector with a marker would need
// a sweep to un-say something the data had already un-said.
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
   * Did the provider record at least one SUCCESSFUL sync strictly AFTER the stream's
   * last row? This is the syncs-continued clause — the whole separation between
   * "the watch is off" and "the phone is off".
   */
  syncedDuringGap: boolean;
  /** The stream's DECLARED dip tolerance, in whole minutes. */
  toleranceMin: number;
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
  /** No ok sync inside the window: a connection outage, which #1685 owns. */
  | "no-ok-sync";

export type QuietStreamVerdict =
  | { quiet: false; skip: QuietStreamSkip }
  | { quiet: true; quietForMin: number };

/**
 * Is this stream quiet right now?
 *
 * The order of the guards is part of the contract: yield to a bigger problem, then
 * check that there was anything to interrupt, then read the data, and only then ask
 * the syncs-continued question — which is the expensive one and the one that decides
 * which detector this outage belongs to.
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
  if (!s.syncedDuringGap) return { quiet: false, skip: "no-ok-sync" };
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
