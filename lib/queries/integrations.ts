import { db } from "@/lib/db";
import type { IntegrationSyncEvent } from "@/lib/types";
import { currentlyFailingProviders } from "@/lib/integrations/sync-log";

// Read side of the integration sync-event debug log. Every statement here is
// PROFILE-SCOPED (WHERE profile_id = ? AND provider = ?): the setup-page panels and
// the grid cards resolve the profile from requireSession(), and the Health Connect
// ingest writes its events under the token-resolved profile, so a profile sees
// exactly its own device's sync history.

// Recent sync events for one provider, newest first — the debug panel's table.
export function getIntegrationSyncEvents(
  profileId: number,
  provider: string,
  limit = 15
): IntegrationSyncEvent[] {
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, provider, limit) as IntegrationSyncEvent[];
}

// Timestamp of the most recent SUCCESSFUL sync for a provider, or null — powers the
// "last successful sync" hint on the setup page and the grid card.
export function getLastSuccessfulSyncAt(
  profileId: number,
  provider: string
): string | null {
  const row = db
    .prepare(
      `SELECT at FROM integration_sync_events
        WHERE profile_id = ? AND provider = ? AND ok = 1
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, provider) as { at: string } | undefined;
  return row?.at ?? null;
}

// All recent sync events for a profile across EVERY provider, newest first — the
// feed behind the Data → Review tab (contrast getIntegrationSyncEvents, which is
// per-provider). Profile-scoped.
export function getRecentSyncEvents(
  profileId: number,
  limit = 30
): IntegrationSyncEvent[] {
  return db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, limit) as IntegrationSyncEvent[];
}

// How many integrations are CURRENTLY in a failed state (their most recent sync
// failed) — the count behind the header "import review" badge. Self-clearing: a
// later successful sync for a provider removes it. Cheap; providers are few, so a
// bounded recent-events scan always contains each provider's latest event.
export function getImportReviewCount(profileId: number): number {
  return currentlyFailingProviders(getRecentSyncEvents(profileId, 100)).length;
}

// The failing-integration events (most recent per currently-broken provider), for
// the Review tab's "Issues" section. Profile-scoped via getRecentSyncEvents.
export function getImportIssues(profileId: number): IntegrationSyncEvent[] {
  return currentlyFailingProviders(getRecentSyncEvents(profileId, 100));
}

// The single most recent event (any outcome) for a provider, or null — the grid
// card uses it for a subtle last-sync time / last-error dot.
export function getLatestSyncEvent(
  profileId: number,
  provider: string
): IntegrationSyncEvent | null {
  const row = db
    .prepare(
      `SELECT * FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, provider) as IntegrationSyncEvent | undefined;
  return row ?? null;
}

// The captured raw-payload ref for one sync event, scoped to the profile — powers
// the admin-only raw viewer route (app/api/integrations/raw/[id]). Profile-scoped
// (id AND profile_id) so one profile can never resolve another's payload by id;
// the route additionally requires the acting login to be an admin.
export function getSyncEventRawRef(
  profileId: number,
  id: number
): string | null {
  const row = db
    .prepare(
      `SELECT raw_ref FROM integration_sync_events
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as { raw_ref: string | null } | undefined;
  return row?.raw_ref ?? null;
}
