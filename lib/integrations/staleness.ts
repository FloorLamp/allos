// PURE silence-tolerance derivation — THE freshness question for a connected
// integration (#1685b, unified in #2263). No DB, no network, so it lives in the pure
// unit tier alongside its sibling registry readers pull-cadence.ts and auth-failure.ts.
//
// ONE QUESTION, ONE RULE. "How long may this source be silent before it is broken?"
// used to have two answers at two incompatible grains:
//
//   • a CONSECUTIVE FAILED RUN count (FAILING_CONSECUTIVE_RUNS = 3, #1880), which is
//     not a measure of whether data is arriving at all. For an hourly source it
//     meant three hours — BELOW the same source's own p90 gap between successes
//     (six hours, measured over 171 runs), so ordinary operation tripped it and
//     Weather & UV read "Sync failing" for 29% of hours while every successful run
//     re-fetched its full 381-row window.
//   • this module's own whole-DAY staleness threshold (#1685), which could see a
//     connection recording NOTHING but only at day grain.
//
// Between "three hours" and "two days" there was no rule at all. So there is now one:
//
//   A connected source escalates when NO SUCCESSFUL RUN has landed within its
//   tolerance — whether the silence was recorded as failures, recorded as nothing,
//   or a mix.
//
// Silence is silence. Both old rules were asking this; neither measured it.
//
// WHY THE LAST SUCCESS, NOT THE LAST DATA. Every polled source records an ok event
// for each successful poll, including a quiet one that found nothing new (isQuietSync
// exists precisely to describe that event). So "last successful sync" tracks the
// CONNECTION's liveness rather than the user's behavior: a week between weigh-ins, or
// a rest week with no activities, is not silence. That is what makes a per-source
// tolerance safe to state at all — see `silenceToleranceMinutes` in the registry for
// each source's reasoning.
//
// WHY THE OTHER DETECTORS DO NOT COVER IT. isAuthRefreshFailure (#326) flips a
// connection to `needs_reauth` only on a DEFINITIVE auth failure — 429/5xx/timeouts
// stay transient on purpose, so a passing cloud hiccup cannot tear down a healthy
// connection. currentlyFailingSources (./sync-log) fires when a source's LATEST
// recorded event is a failure, so it can only see events that were actually recorded.
// Neither can see a connection that is recording nothing: a Health Connect exporter
// the phone stopped running, a poll that never gets far enough to log an event, a
// "transient" condition that lasts for weeks. The only evidence is negative, and this
// is the module that reads it.

import type { IntegrationDef } from "../types";
import { parseSyncEventAt, pullCadenceMinutes } from "./pull-cadence";

// How many missed POLLS a source tolerates before its silence is treated as broken,
// when it does not override the number itself. Twelve — half a day of missed polls at
// whatever cadence the source declares. DECLARED here rather than fitted to an
// observed distribution: the threshold is a policy about how long a person should be
// left uninformed, and the measurement's job is to check that the policy clears the
// source's ordinary variance (weather's p90 success gap is 6 h against this 12 h),
// not to set it.
export const DEFAULT_SILENCE_TOLERANCE_POLLS = 12;

// The source's silence tolerance in whole minutes, or null when it is exempt. The
// ONE reader of the registry field: callers ask this rather than touching
// `silenceToleranceMinutes`, so "what counts as exempt" and "where does the default
// come from" are decided once.
//
// Three cases, in order:
//   • an explicit number  → that tolerance;
//   • an explicit null    → EXEMPT, a statement about the source (a manual archive
//                           import has no cadence to be late against; a planned or
//                           outbound entry never syncs inbound at all);
//   • undeclared          → derived from the source's own declared poll cadence.
//                           A source with no `pull` facet has no poll interval to
//                           derive from and is treated as exempt here, which is the
//                           safe direction — the registry completeness test in
//                           lib/__tests__/sync-staleness.test.ts is what fails it, in
//                           the METRIC_KNOWLEDGE idiom where every entry declares a
//                           policy or an explicit exemption with a reason.
//
// An unknown source (a connection row for a retired or hand-inserted id) is exempt:
// we cannot state a cadence we know nothing about.
export function silenceToleranceMinutes(
  def: IntegrationDef | undefined
): number | null {
  if (!def) return null;
  const declared = def.silenceToleranceMinutes;
  if (declared === null) return null;
  if (typeof declared === "number") return declared > 0 ? declared : null;
  if (!def.pull) return null;
  return pullCadenceMinutes(def) * DEFAULT_SILENCE_TOLERANCE_POLLS;
}

// One connected source's freshness facts, as the DB layer reduces them.
export interface SyncFreshness {
  // The integration id (the `source` column value).
  sourceId: string;
  // Timestamp of the most recent ok=1 sync event, or null when the connection has never
  // had one.
  lastSuccessAt: string | null;
  // The source's tolerance in whole minutes; null = exempt.
  toleranceMinutes: number | null;
  // True when this source is ALREADY represented by a failing/needs-reauth signal.
  // The silence item must not double-report (#1685): a source you have been told to
  // reconnect does not also need to be told it has no recent data — the reauth item
  // names the cause, and this one would only name the symptom.
  alreadyFailing: boolean;
}

// A source that has gone quiet, with the facts its copy needs.
export interface StaleSync {
  sourceId: string;
  // The YYYY-MM-DD of the last successful sync — the date the "no data since" copy names.
  since: string;
  // The INSTANT of that last success. The synthetic issue row stamps its `at` /
  // `created_at` with this: those columns hold instants, and stamping them with a
  // bare DATE made a row that sorted and compared as midnight (#2263).
  sinceAt: string;
  // Whole minutes of silence from that success to `now`, for the duration copy.
  minutes: number;
}

// The YYYY-MM-DD day part of a stored timestamp. Sync-event `at` values are written as
// an ISO instant ("YYYY-MM-DDTHH:MM:SSZ", #2205) and legacy rows may still hold
// SQLite's bare "YYYY-MM-DD HH:MM:SS"; both begin with the day, so the day is the first
// 10 chars. Kept only where a DAY is genuinely wanted — the "No data since <date>"
// copy — never for the arithmetic, which is on instants now.
export function syncDay(at: string): string {
  return at.slice(0, 10);
}

// Whole minutes between a stored timestamp and `now`, or null when either is
// unreadable. Negative when the stamp is in the FUTURE (a container whose clock
// stepped back), which every caller reads as "not silent" rather than as a breach.
export function silenceMinutes(at: string, now: string): number | null {
  const atMs = parseSyncEventAt(at);
  const nowMs = parseSyncEventAt(now);
  if (atMs == null || nowMs == null) return null;
  return Math.floor((nowMs - atMs) / 60_000);
}

// A silence duration in the coarsest unit that still states it honestly. FLOORED at
// every step, never rounded: "hasn't synced in 11 days" must not become 12 because the
// stamp sat 14 hours into the twelfth.
export function formatSilence(minutes: number): string {
  const m = Math.max(0, minutes);
  if (m < 120) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// A DECLARED tolerance, in the words the escalation policy states it in. Same unit
// ladder as formatSilence, but tolerances are exact by construction (12 h, 3 days), so
// this reads them out rather than flooring an observation.
export function formatTolerance(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

// Whether a connected source has been silent past its tolerance, measured against
// `now` as an INSTANT (the caller resolves it through the lib/clock.ts seam).
//
// Strictly greater than the tolerance, matching the freshness doctrine: a reading is
// stale strictly AFTER its interval, so a source exactly at its tolerance is still
// current.
//
// Three deliberate non-firings:
//   1. an exempt source (null tolerance) is never silent;
//   2. a source already carrying a failing/needs-reauth signal is never ALSO silent —
//      the reauth item wins, so a broken connection is reported once;
//   3. a connection with NO successful sync EVER is not silent. The copy this feeds is
//      "no data since <date>", which requires a date; a connection that has never
//      succeeded is a setup problem the source's own page already shows, and firing on
//      it would flag every freshly-created connection before its first tick. Silence
//      means "it was working and stopped", which is the state nothing else can see.
export function isSyncStale(f: SyncFreshness, now: string): boolean {
  if (f.toleranceMinutes == null) return false;
  if (f.alreadyFailing) return false;
  if (f.lastSuccessAt == null) return false;
  const minutes = silenceMinutes(f.lastSuccessAt, now);
  return minutes != null && minutes > f.toleranceMinutes;
}

// Every quiet source among the connected ones, in input order. The single entry point
// the DB layer calls; the badge, the attention item and the digest line all read its
// output, so they cannot disagree about which sources have stopped (#221).
export function staleSyncs(
  freshness: readonly SyncFreshness[],
  now: string
): StaleSync[] {
  const out: StaleSync[] = [];
  for (const f of freshness) {
    if (!isSyncStale(f, now)) continue;
    const sinceAt = f.lastSuccessAt!;
    out.push({
      sourceId: f.sourceId,
      since: syncDay(sinceAt),
      sinceAt,
      minutes: silenceMinutes(sinceAt, now) ?? 0,
    });
  }
  return out;
}

// The ONE copy for a stale connection, shared by the Data → Review issue row, the
// attention item's detail, and the digest line. Distinct from the reauth wording on
// purpose (#1685): a revoked grant needs your consent again ("Reconnect"), while this
// connection may be perfectly authorized and simply not delivering — so it states the
// observation and asks you to check, rather than claiming to know the cause.
//
// Duration-aware since #2263: a 14-hour silence is now escalatable, so the sentence
// has to be able to say "14 hours" as well as "4 days".
export function staleSyncDetail(providerName: string, s: StaleSync): string {
  return `No data since ${s.since} — ${providerName} hasn't synced successfully in ${formatSilence(s.minutes)}. Check the connection.`;
}

// The attention item's title for a stale connection. Says what is true (it stopped)
// without asserting why.
export function staleSyncTitle(providerName: string): string {
  return `${providerName} sync has stopped`;
}

// The sentinel id every SYNTHETIC stale-sync issue carries, mirroring the
// expired-Health-Connect issue's -1. Real events come from an AUTOINCREMENT column, so a
// negative id can never collide with one; a single shared sentinel lets any reader tell
// "this connection went quiet" apart from "this connection reported a failure" without a
// second read — which is what both the attention item and the Data → Review row need in
// order to pick their copy.
//
// Because the sentinel is SHARED across sources it is not unique per row: a list
// rendering these must key on (source, id), never on id alone.
export const STALE_SYNC_EVENT_ID = -2;

// Whether an import issue is the synthetic staleness signal rather than a recorded
// failure. Pure (and client-safe) so the server gather, the attention item and the
// Data → Review row all ask the same question.
export function isStaleSyncEvent(ev: { id: number }): boolean {
  return ev.id === STALE_SYNC_EVENT_ID;
}
