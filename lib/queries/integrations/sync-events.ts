// SYNC EVENTS — one of the three submodules behind lib/queries/integrations.ts
// (issue #5171): the per-source sync-event ledger reads (recent, retained, paged by
// profile-local day, by id, latest per source) and the per-source state record
// (getIntegrationState / getConnectedSources) every rendered surface reads. The two
// reads the standing resolution composes live in ./common. Every read is
// profile-scoped.

import { db, today } from "@/lib/db";
import { getTimezone } from "@/lib/settings";
import type {
  IntegrationId,
  IntegrationKind,
  IntegrationSyncEvent,
} from "@/lib/types";
import type { StaleSync } from "@/lib/integrations/staleness";
import { shouldShowConnectedSource } from "@/lib/integrations/sync-log";
import {
  observedSuccessCadenceMinutes,
  syncVocabularyForKind,
  STANDING_RUN_WINDOW,
  type SourceStanding,
  type SyncVocabulary,
} from "@/lib/integrations/source-state";
import {
  isScheduledKind,
  type IntegrationDelivery,
} from "@/lib/integrations/delivery";
import { syncEventDay } from "@/lib/integrations/sync-history-days";
import {
  getIntegrationBackfillJobs,
  type IntegrationBackfillJob,
} from "@/lib/integrations/backfill-state";
import {
  INTEGRATIONS,
  getIntegration,
  isPullIntegration,
} from "@/lib/integrations/registry";
import { getIntegrationSyncEvents, resolveSourceFacts } from "./common";
import { provenanceCountsByEvent } from "./provenance";

// Read side of the integration sync-event debug log. Every statement here is
// PROFILE-SCOPED (WHERE profile_id = ? AND source_id = ?): the setup-page panels and
// the grid cards resolve the profile from requireSession(), and the Health Connect
// ingest writes its events under the token-resolved profile, so a profile sees
// exactly its own device's sync history.

// The source page promises the FULL retained history, whose age is bounded by the
// #388 sweep. This deliberately has no row cap: a cap can bisect a profile-local day,
// making that day's aggregate false and hiding an anomaly earlier in the same day.
// Review remains a short status window and uses getIntegrationSyncEvents instead.
export function getRetainedIntegrationSyncEvents(
  profileId: number,
  sourceId: string
): IntegrationSyncEvent[] {
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND source_id = ?
        ORDER BY at DESC, id DESC`
    )
    .all(profileId, sourceId) as IntegrationSyncEvent[];
}

export const SYNC_HISTORY_PAGE_DAYS = 7;

export interface IntegrationSyncEventPage {
  events: IntegrationSyncEvent[];
  // Exclusive profile-local day cursor for the next older page.
  nextBefore: string | null;
}

// Page over COMPLETE profile-local days. The retained ledger is age-bounded and is
// scanned here only on the server; the client receives events for seven days at a
// time, so a busy push source no longer ships its whole 90-day history on first load.
export function getIntegrationSyncEventPage(
  profileId: number,
  sourceId: string,
  timeZone: string,
  beforeDay: string | null,
  dayLimit = SYNC_HISTORY_PAGE_DAYS
): IntegrationSyncEventPage {
  const limit = Math.max(1, dayLimit);
  const eligible = getRetainedIntegrationSyncEvents(profileId, sourceId).filter(
    (event) => beforeDay == null || syncEventDay(event.at, timeZone) < beforeDay
  );
  const dayKeys: string[] = [];
  for (const event of eligible) {
    const day = syncEventDay(event.at, timeZone);
    if (dayKeys[dayKeys.length - 1] !== day) dayKeys.push(day);
  }
  const selectedDays = dayKeys.slice(0, limit);
  if (selectedDays.length === 0) return { events: [], nextBefore: null };
  const selected = new Set(selectedDays);
  return {
    events: eligible.filter((event) =>
      selected.has(syncEventDay(event.at, timeZone))
    ),
    nextBefore:
      dayKeys.length > limit ? selectedDays[selectedDays.length - 1] : null,
  };
}

// Lazy range expansion: resolve only the ids the already-authorized page supplied,
// and re-check both profile and source at the SQL boundary.
export function getIntegrationSyncEventsByIds(
  profileId: number,
  sourceId: string,
  ids: readonly number[]
): IntegrationSyncEvent[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND source_id = ? AND id IN (${placeholders})
        ORDER BY at DESC, id DESC`
    )
    .all(profileId, sourceId, ...ids) as IntegrationSyncEvent[];
}

// The single most recent event (any outcome) for EACH source the profile has any
// sync history for — one row per source, newest-first overall. Unlike a window-
// capped "N newest across all sources" read, this is uncapped PER SOURCE by
// construction (a correlated `id = latest-for-this-source` match), so a source
// whose latest event is a failure is never lost behind a chattier source's flood of
// recent rows (issue #304). This is the failure detector's feed: it matches, row for
// row, what each grid card shows via getLatestSyncEvent, so the badge/dashboard and the
// per-source card can no longer disagree. Profile-scoped.
export function getLatestSyncEventPerSource(
  profileId: number
): IntegrationSyncEvent[] {
  // Instead of scanning every event with a correlated `id = latest-for-source`
  // subquery per row (issue #388), enumerate the profile's DISTINCT providers and do
  // ONE indexed seek per source — idx_sync_events_profile_source_at
  // (profile_id, source_id, at) satisfies both the DISTINCT skip-scan and each
  // `ORDER BY at DESC, id DESC LIMIT 1`, so this is O(sources × log N) rather than
  // O(N) with a per-row subquery. Output is byte-identical: the latest event per
  // source, ordered newest-first overall.
  const sourceIds = db
    .prepare(
      `SELECT DISTINCT source_id FROM integration_sync_events
        WHERE profile_id = ?`
    )
    .all(profileId) as { source_id: string }[];
  const latest = db.prepare(
    `SELECT * FROM integration_sync_events
      WHERE profile_id = ? AND source_id = ?
      ORDER BY at DESC, id DESC
      LIMIT 1`
  );
  const out: IntegrationSyncEvent[] = [];
  for (const { source_id: sourceId } of sourceIds) {
    const ev = latest.get(profileId, sourceId) as
      IntegrationSyncEvent | undefined;
    if (ev) out.push(ev);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
}

// The single most recent event (any outcome) for a source, or null — the grid
// card uses it for a subtle last-sync time / last-error dot.
export function getLatestSyncEvent(
  profileId: number,
  sourceId: string
): IntegrationSyncEvent | null {
  const row = db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND source_id = ?
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, sourceId) as IntegrationSyncEvent | undefined;
  return row ?? null;
}

// THE per-source state record (#1772). One source used to be described by four
// surfaces in three visual languages — the Integrations grid card, the setup page's
// status card (its own badge, a raw SQLite UTC timestamp, and the `last_sync_summary`
// JSON echoed as key:value badges, a third accounting with no formatter),
// IntegrationSyncHistoryLink, and Review's Connected-sources card. They now all read
// THIS, and format it through the pure lib/integrations/source-state helpers.
//
// `canSyncNow` marks a source the app can pull on demand; a push-only source
// (Health Connect) explains that instead of offering the button.
export interface IntegrationState {
  id: IntegrationId;
  name: string;
  // TYPED (#2301), not `string`. Every surface that asks a kind question — which
  // dialect, which run noun, which delivery family — now gets an exhaustive answer
  // instead of one that silently defaults.
  kind: IntegrationKind;
  // WHO MOVES THE DATA, resolved once here so no surface re-derives it. It decides
  // which FAMILY of standings this source's `standing` is drawn from, and therefore
  // which questions the surface may ask about it at all.
  delivery: IntegrationDelivery;
  connected: boolean;
  // The source's credential died (dead/revoked token) and it flipped to
  // `needs_reauth` (issue #326) — distinct from a never-configured / user-removed
  // "not connected". The card surfaces a "Needs reconnect" prompt instead of the
  // benign "Not connected" one.
  needsReauth: boolean;
  canSyncNow: boolean;
  latest: IntegrationSyncEvent | null;
  history: IntegrationSyncEvent[];
  // Older-day cursor for the source page. Review's short status window is not
  // paged and carries null.
  historyNextBefore: string | null;
  // How many rows the drill-in can actually LIST, per event id, among `latest` +
  // `history` (#1771, corrected in #1991). An event absent from this map recorded no
  // provenance and gets no expander at all rather than one that apologizes on open.
  // The COUNT matters as much as the presence: "What this wrote (30)" used to label
  // the split total while listing only what `integration_sync_rows` holds — and
  // recordSyncRows deliberately skips minute-grain tables with no row id — so on a
  // Health Connect push it overstated by 10× and a partial list looked complete.
  provenanceCounts: Record<number, number>;
  // The last run that SUCCEEDED, however long ago — what the setup page's status
  // header reports when the latest attempt failed.
  lastSuccessAt: string | null;
  // The pure derivations, resolved once here so no surface re-derives them: which
  // shape the source is in, and which words its counts are reported in.
  standing: SourceStanding;
  // The record types this LIVE source is discarding (#4975) — the `dropping`
  // standing's own evidence, so a surface can say WHICH data is being lost instead of
  // only that some is. Empty for every other standing.
  droppedTypes: string[];
  vocabulary: SyncVocabulary;
  // The quiet-stop facts when the silence rule fires (a `failing` standing whose
  // latest run SUCCEEDED long ago) — the "no data since <date>" copy's ingredients.
  // Null otherwise.
  stale: StaleSync | null;
  // The standing window's tally (#1880): how many of the last `total` runs failed,
  // for the intermittent surfaces' honest "3 of the last 10 runs failed" copy.
  recentRuns: { total: number; failed: number };
  // The OBSERVED median gap between successful runs in that window, in whole minutes
  // (#2263 decision 4) — the SIGNAL the amber surfaces state beside the failure
  // tally, which is only the noise. Null when the window holds fewer than two
  // successes. Display only: it never feeds the declared escalation tolerance.
  successCadenceMinutes: number | null;
  // The PROFILE's time zone and its today, resolved once here (#1991). History groups
  // by DAY, and a day is the reader's — a UTC slice would put a 21:00 local push on
  // the wrong side of midnight for anyone east or west of Greenwich.
  timeZone: string;
  today: string;
  // Durable enrichment work (progress survives navigation/restarts).
  backfills: IntegrationBackfillJob[];
}

// Retained for the surfaces that speak of "connected sources" (Data → Review). Same
// record — the name is the surface's, the shape is the model's.
export type ConnectedSource = IntegrationState;

// "Connected sources" is the SCHEDULED family, and since #2301 it says so by reading
// the declared delivery axis (`isScheduledKind` over `KIND_DELIVERY`) instead of
// re-enumerating members. It used to be `RECURRING_SOURCE_KINDS`, a `Set<string>`
// naming four of the seven kinds by hand — and that hand-enumeration had already
// caused this exact bug once: `public` was missing, which left Weather's successful
// history unreachable while its failures still showed under Needs attention (#1614).
// Attended sources (a Takeout archive, patient portals) reach Review through the
// chronological Imports feed instead; the outbound calendar feed imports nothing.

// The recurring-stream sources for the "Connected sources" section, each collapsed
// to its latest sync outcome plus a short expandable history. Profile-scoped via the
// per-source reads it composes (getConnection / getLatestSyncEvent /
// getIntegrationSyncEvents). A source is only surfaced once it's been set up:
// currently connected, or carrying historical sync events (issue #294) — a
// never-configured integration is hidden rather than shown as an empty
// "Not connected" card.
export function getConnectedSources(profileId: number): ConnectedSource[] {
  return INTEGRATIONS.filter(
    (i) => i.status === "available" && isScheduledKind(i.kind)
  )
    .map((i) => getIntegrationState(profileId, i.id, REVIEW_HISTORY_LIMIT))
    .filter((s): s is IntegrationState => s !== null)
    .filter((s) =>
      shouldShowConnectedSource({
        connected: s.connected,
        hasHistory: s.history.length > 0,
      })
    );
}

// How many events each surface loads. Review is an inbox — it shows the current
// state, so it needs only enough history to say whether the latest run is typical.
// The setup page is the source's HOME and owns the paged retained ledger.
const REVIEW_HISTORY_LIMIT = 10;
export const SETUP_HISTORY_LIMIT = "paged" as const;

// ONE source's complete state, for whichever surface is asking (#1772): the
// Integrations grid card, its setup page's status header + history table, or Review's
// Connected-sources entry. Returns null for an id that isn't a registered
// integration. Profile-scoped through every read it composes.
export function getIntegrationState(
  profileId: number,
  sourceId: string,
  historyLimit: number | typeof SETUP_HISTORY_LIMIT = REVIEW_HISTORY_LIMIT
): IntegrationState | null {
  const def = getIntegration(sourceId as IntegrationId);
  if (!def) return null;
  const facts = resolveSourceFacts(profileId, def.id);
  const timeZone = getTimezone(profileId);
  // The DISPLAY history is independent from the fixed STANDING window. Setup gets
  // seven complete local days; Review keeps its short event slice.
  let historyNextBefore: string | null = null;
  let history: IntegrationSyncEvent[];
  if (historyLimit === SETUP_HISTORY_LIMIT) {
    const page = getIntegrationSyncEventPage(profileId, def.id, timeZone, null);
    history = page.events;
    historyNextBefore = page.nextBefore;
  } else {
    history =
      historyLimit <= STANDING_RUN_WINDOW
        ? facts.window.slice(0, Math.max(0, historyLimit))
        : getIntegrationSyncEvents(profileId, def.id, historyLimit);
  }
  const ids = history.map((e) => e.id);
  if (facts.latest) ids.push(facts.latest.id);
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    delivery: facts.delivery,
    connected: facts.connected,
    needsReauth: facts.needsReauth,
    // Which sources can be synced on demand is a REGISTRY fact now (#2040): a
    // source with a pull facet has a runner behind the button. Health Connect is
    // push-only and shows an explainer instead.
    canSyncNow: isPullIntegration(def),
    latest: facts.latest,
    history,
    historyNextBefore,
    provenanceCounts: ids.length
      ? provenanceCountsByEvent(profileId, def.id, Math.min(...ids))
      : {},
    lastSuccessAt: facts.lastSuccessAt,
    standing: facts.standing,
    droppedTypes: facts.droppedTypes,
    vocabulary: syncVocabularyForKind(def.kind),
    stale: facts.stale,
    recentRuns: {
      total: facts.window.length,
      failed: facts.window.filter((e) => !e.ok).length,
    },
    successCadenceMinutes: observedSuccessCadenceMinutes(facts.window),
    timeZone,
    today: today(profileId),
    backfills: getIntegrationBackfillJobs(profileId, def.id),
  };
}
