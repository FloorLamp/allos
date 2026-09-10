// Directory-private helpers shared by the submodules behind lib/queries/integrations.ts
// (issue #5171): the per-source standing resolution (resolveSourceFacts) that both
// getIntegrationState (./sync-events) and getImportIssues (./decisions) read, the
// dropped-types window it and droppingIntegrations share, and the two sync-event
// reads the standing composes. Those two reads are public (the barrel re-exports
// them); everything else is private to the directory.

import { db, hoistedStatement } from "@/lib/db";
import { cache } from "@/lib/request-cache";
import { instantNow } from "@/lib/clock";
import { getTimezone } from "@/lib/settings";
import type { IntegrationId, IntegrationSyncEvent } from "@/lib/types";
import {
  staleSyncs,
  silenceToleranceMinutes,
  silenceMinutes,
  type StaleSync,
} from "@/lib/integrations/staleness";
import { droppedTypes } from "@/lib/integrations/sync-details";
import {
  sourceStanding,
  STANDING_RUN_WINDOW,
  type SourceStanding,
} from "@/lib/integrations/source-state";
import type { IntegrationDelivery } from "@/lib/integrations/delivery";
import {
  getIntegration,
  integrationDelivery,
} from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";

// Recent sync events for one source, newest first — the debug panel's table.
export function getIntegrationSyncEvents(
  profileId: number,
  sourceId: string,
  limit = 15
): IntegrationSyncEvent[] {
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND source_id = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, sourceId, limit) as IntegrationSyncEvent[];
}

// Timestamp of the most recent SUCCESSFUL sync for a source, or null — powers the
// "last successful sync" hint on the setup page and the grid card.
export function getLastSuccessfulSyncAt(
  profileId: number,
  sourceId: string
): string | null {
  const row = db
    .prepare(
      `SELECT at FROM integration_sync_events
        WHERE profile_id = ? AND source_id = ? AND ok = 1
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, sourceId) as { at: string } | undefined;
  return row?.at ?? null;
}

// THE per-source standing resolution (#1772, flap-aware since #1880): connection
// status + the recent run window + the #1685 staleness facts, folded through the ONE
// pure derivation (sourceStanding). Both getIntegrationState (every rendered
// surface) and getImportIssues (the badge / Needs attention / digest feed) read this
// helper, so a surface and the escalation set can never disagree about a source's
// shape. Profile-scoped through every read it composes.
interface SourceFacts {
  connected: boolean;
  needsReauth: boolean;
  latest: IntegrationSyncEvent | null;
  // The newest-first standing window (STANDING_RUN_WINDOW events) — the SAME depth
  // for every caller, however much display history it asked for.
  window: IntegrationSyncEvent[];
  lastSuccessAt: string | null;
  // The quiet-stop facts when the silence rule fires for this CONNECTED source,
  // for the "no data since" copy. Null otherwise.
  stale: StaleSync | null;
  standing: SourceStanding;
  // The types this source received and never landed over its silence tolerance
  // (#4975) — the standing's own evidence, carried so the surfaces can NAME what is
  // being dropped instead of saying only that something is. Empty for every source
  // that is not `dropping`.
  droppedTypes: string[];
  // WHO MOVES THE DATA (#2301) — resolved from the registry kind here and carried, so
  // the standing and every surface reading it agree on which family it came from.
  delivery: IntegrationDelivery;
}

function resolveSourceFacts(
  profileId: number,
  sourceId: IntegrationId
): SourceFacts {
  const def = getIntegration(sourceId);
  const status = getConnection(profileId, sourceId)?.status;
  const connected = status === "connected";
  const needsReauth = status === "needs_reauth";
  const window = getIntegrationSyncEvents(
    profileId,
    sourceId,
    STANDING_RUN_WINDOW
  );
  const latest = window[0] ?? null;
  const lastSuccessAt = getLastSuccessfulSyncAt(profileId, sourceId);
  const toleranceMinutes = silenceToleranceMinutes(def);
  // NOW as an instant, through the clock seam (#2263): the silence rule is instant
  // arithmetic against `integration_sync_events.at`, which migration 163 put on the
  // canonical UTC+`Z` convention, so the comparison is lexically and numerically safe.
  const nowAt = instantNow();
  // The quiet-stop copy facts, from the same staleSyncs derivation the standing
  // composes (`alreadyFailing: false` — this IS the failing derivation, so there is
  // no other signal to defer to; getImportIssues still reports each source once).
  const stale = connected
    ? (staleSyncs(
        [
          {
            sourceId: sourceId,
            lastSuccessAt,
            toleranceMinutes,
            alreadyFailing: false,
          },
        ],
        nowAt,
        // The profile whose local day "No data since <date>" names. Resolved here
        // because this is the layer that has the profile; staleness.ts is pure (#3573).
        getTimezone(profileId)
      )[0] ?? null)
    : null;
  const delivery = integrationDelivery(def);
  // Only a CONNECTED, SCHEDULED source can be dropping: an attended import and an
  // outbound feed record no per-run tally and declare no tolerance, so nothing else
  // pays this read. It is the SAME read the attention row makes — memoized per
  // request, so asking here costs the render nothing it was not already spending.
  const droppedTypesList =
    connected && delivery === "scheduled"
      ? droppedTypesForSource(profileId, sourceId)
      : [];
  return {
    connected,
    needsReauth,
    latest,
    window,
    lastSuccessAt,
    stale,
    delivery,
    droppedTypes: droppedTypesList,
    standing: sourceStanding({
      delivery,
      connected,
      needsReauth,
      latest,
      recentRuns: window,
      lastSuccessAt,
      toleranceMinutes,
      now: nowAt,
      droppedTypes: droppedTypesList,
    }),
  };
}

// How many recent runs the dropping derivation reads per source. A CAP on the ROWS, not
// the window — the window is the source's own silence tolerance (#2263) — and it exists
// because `details` is up to 4 KB per run and this read is on the dashboard and digest
// paths. 60 runs covers a 12 h tolerance at one run every 12 minutes, comfortably past
// the Health Connect exporter's ~20-minute re-push, the densest source here.
//
// If a source ever DOES out-push it, the verdict is taken from its 60 most recent runs
// inside the tolerance, which is the honest reading rather than a degraded one: sixty
// consecutive pushes that all received a type and landed none of it is a live drop
// whatever happened before them.
const DROPPING_RUN_CAP = 60;

const DROPPING_RUNS_STMT = hoistedStatement(
  `SELECT at, ok, details FROM integration_sync_events
    WHERE profile_id = ? AND source_id = ?
    ORDER BY at DESC, id DESC
    LIMIT ${DROPPING_RUN_CAP}`
);

// THE TYPES ONE SOURCE HAS RECEIVED AND NEVER LANDED, over its own silence tolerance
// (#4956). Read ONCE per source per request, because since #4975 there are TWO askers
// and they must be looking at the same window: the STANDING (`resolveSourceFacts`,
// which is what the grid card, the source page and Review's escalated card render)
// and the ATTENTION ROW (`droppingIntegrations`, which is what the dashboard, Upcoming
// and the digest render). Two windows would let a source carry the badge without the
// row, or the row without the badge, about one question — the #221 disease this whole
// module exists to avoid.
//
// NOW is read INSIDE rather than passed, so the memo keys on (profile, source) alone:
// `cache()` keys by argument identity, and two callers reading the clock a
// millisecond apart would miss it and pay the read twice. Sound for the same reason
// #2283's tick memo is — the quantity compared is a silence tolerance in HOURS.
//
// A source with no declared tolerance has no window to judge over — the same
// exemption the staleness rule takes — and never issues the read at all.
const droppedTypesForSource = cache(
  (profileId: number, sourceId: IntegrationId): string[] => {
    const tolerance = silenceToleranceMinutes(getIntegration(sourceId));
    if (tolerance == null) return [];
    const nowAt = instantNow();
    const runs = DROPPING_RUNS_STMT.all(profileId, sourceId) as {
      at: string;
      ok: number;
      details: string | null;
    }[];
    return droppedTypes(
      runs.filter((r) => (silenceMinutes(r.at, nowAt) ?? Infinity) <= tolerance)
    );
  }
);

// Shared with the sibling submodules only; the barrel does not re-export these.
export { droppedTypesForSource, resolveSourceFacts };
