// PURE last-successful-sync staleness derivation (issue #1685b). No DB, no network, so
// it lives in the pure unit tier alongside its sibling classifier auth-failure.ts.
//
// THE GAP THIS COVERS. Two existing signals decide that an integration needs attention,
// and both are event-driven:
//
//   • isAuthRefreshFailure (#326) flips a connection to `needs_reauth` only on a
//     DEFINITIVE auth failure. 429/5xx/timeouts stay transient on purpose — otherwise a
//     passing cloud hiccup would tear down a healthy connection.
//   • currentlyFailingProviders (./sync-log) fires when a provider's LATEST recorded
//     event is a failure. It is self-clearing and honest, but it can only see events
//     that were actually recorded.
//
// Neither can see a connection that is recording NOTHING. A Health Connect exporter the
// phone stopped running, a poll that never gets far enough to log an event, a "transient"
// condition that lasts for weeks — each leaves the connection sitting at `connected`,
// with a green badge, syncing nothing. The only evidence is negative: no successful sync
// for a long time. That is what this module reads.
//
// WHY THE LAST SUCCESS, NOT THE LAST DATA. Every polled provider records an ok event for
// each successful poll, including a quiet one that found nothing new (isQuietSync exists
// precisely to describe that event). So "last successful sync" tracks the CONNECTION's
// liveness rather than the user's behavior: a week between weigh-ins, or a rest week with
// no activities, is not staleness. That is what makes a per-provider day threshold safe
// to state at all — see `staleAfterDays` in the registry for each provider's reasoning.

import { daysBetweenDateStr } from "../date";
import type { IntegrationDef } from "../types";

// The provider's threshold, or null when it is exempt. The ONE reader of the registry
// field: callers ask this rather than touching `staleAfterDays`, so "what counts as
// exempt" is decided once. An unknown provider (a connection row for a retired or
// hand-inserted id) is exempt — we cannot state a cadence we know nothing about.
export function syncStalenessThreshold(
  def: IntegrationDef | undefined
): number | null {
  const days = def?.staleAfterDays;
  return typeof days === "number" && days > 0 ? days : null;
}

// One connected provider's freshness facts, as the DB layer reduces them.
export interface SyncFreshness {
  // The integration id (the `provider` column value).
  provider: string;
  // Timestamp of the most recent ok=1 sync event, or null when the connection has never
  // had one.
  lastSuccessAt: string | null;
  // The provider's registry threshold in whole days; null = exempt.
  thresholdDays: number | null;
  // True when this provider is ALREADY represented by a failing/needs-reauth signal.
  // The staleness item must not double-report (#1685): a provider you have been told to
  // reconnect does not also need to be told it has no recent data — the reauth item
  // names the cause, and this one would only name the symptom.
  alreadyFailing: boolean;
}

// A provider that has gone quiet, with the facts its copy needs.
export interface StaleSync {
  provider: string;
  // The YYYY-MM-DD of the last successful sync — the date the "no data since" copy names.
  since: string;
  // Whole days from `since` to today, for the "N days ago" detail.
  days: number;
}

// The YYYY-MM-DD day part of a stored timestamp. Sync-event `at` values are written by
// SQLite's datetime('now') ("YYYY-MM-DD HH:MM:SS") or as an ISO instant
// ("YYYY-MM-DDTHH:MM:SSZ"); both begin with the day, so the day is the first 10 chars.
export function syncDay(at: string): string {
  return at.slice(0, 10);
}

// Whether a connected provider has gone quiet, given today's date in ITS PROFILE's
// timezone (the caller resolves that — this layer is calendar-based and tz-independent,
// matching daysUntilDue in lib/upcoming.ts).
//
// Three deliberate non-firings:
//   1. an exempt provider (null threshold) is never stale;
//   2. a provider already carrying a failing/needs-reauth signal is never ALSO stale —
//      the reauth item wins, so a broken connection is reported once;
//   3. a connection with NO successful sync EVER is not stale. The copy this feeds is
//      "no data since <date>", which requires a date; a connection that has never
//      succeeded is a setup problem the provider's own page already shows, and firing on
//      it would flag every freshly-created connection in the window before its first
//      tick. Staleness means "it was working and stopped", which is the state nothing
//      else can see.
export function isSyncStale(f: SyncFreshness, today: string): boolean {
  if (f.thresholdDays == null) return false;
  if (f.alreadyFailing) return false;
  if (f.lastSuccessAt == null) return false;
  const days = daysBetweenDateStr(syncDay(f.lastSuccessAt), today);
  return days != null && days > f.thresholdDays;
}

// Every quiet provider among the connected ones, in input order. The single entry point
// the DB layer calls; the badge, the attention item and the digest line all read its
// output, so they cannot disagree about which providers have stopped (#221).
export function staleSyncs(
  freshness: readonly SyncFreshness[],
  today: string
): StaleSync[] {
  const out: StaleSync[] = [];
  for (const f of freshness) {
    if (!isSyncStale(f, today)) continue;
    const since = syncDay(f.lastSuccessAt!);
    out.push({
      provider: f.provider,
      since,
      days: daysBetweenDateStr(since, today) ?? 0,
    });
  }
  return out;
}

// The ONE copy for a stale connection, shared by the Data → Review issue row, the
// attention item's detail, and the digest line. Distinct from the reauth wording on
// purpose (#1685): a revoked grant needs your consent again ("Reconnect"), while this
// connection may be perfectly authorized and simply not delivering — so it states the
// observation and asks you to check, rather than claiming to know the cause.
export function staleSyncDetail(providerName: string, s: StaleSync): string {
  return `No data since ${s.since} — ${providerName} hasn't synced successfully in ${s.days} days. Check the connection.`;
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
// Because the sentinel is SHARED across providers it is not unique per row: a list
// rendering these must key on (provider, id), never on id alone.
export const STALE_SYNC_EVENT_ID = -2;

// Whether an import issue is the synthetic staleness signal rather than a recorded
// failure. Pure (and client-safe) so the server gather, the attention item and the
// Data → Review row all ask the same question.
export function isStaleSyncEvent(ev: { id: number }): boolean {
  return ev.id === STALE_SYNC_EVENT_ID;
}
