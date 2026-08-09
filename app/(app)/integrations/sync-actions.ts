"use server";
import { requireSession, requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import type { IntegrationId } from "@/lib/types";
import {
  getIntegration,
  getPullIntegration,
} from "@/lib/integrations/registry";
import { getPullRunner } from "@/lib/integrations/pull-runners";
import { createLogger } from "@/lib/log";
import { isRealIsoDate } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import {
  getIntegrationSyncEventPage,
  getIntegrationSyncEventsByIds,
  getLatestSyncEvent,
  provenanceCountsByEvent,
  SYNC_HISTORY_PAGE_DAYS,
} from "@/lib/queries";
import { syncVocabularyForKind } from "@/lib/integrations/provider-state";
import {
  projectSyncHistoryDays,
  projectSyncRun,
  type SyncHistoryPageView,
  type SyncRunView,
} from "@/lib/integrations/sync-history-view";

const log = createLogger("sync-now");

export interface SyncNowResult {
  status: "done" | "error";
  message: string;
}

// Read-only pagination for the provider-owned ledger. The cursor is a complete,
// exclusive profile-local day, so a page boundary can never split a day's totals or
// hide one of its anomalies. Provider/profile are both revalidated server-side.
export async function loadSyncHistoryPage(
  id: IntegrationId,
  beforeDay: string
): Promise<SyncHistoryPageView> {
  const { profile } = await requireSession();
  const def = getIntegration(id);
  if (!def || !isRealIsoDate(beforeDay)) {
    return { days: [], nextBefore: null };
  }
  const timeZone = getTimezone(profile.id);
  const page = getIntegrationSyncEventPage(
    profile.id,
    def.id,
    timeZone,
    beforeDay,
    SYNC_HISTORY_PAGE_DAYS
  );
  const counts = page.events.length
    ? provenanceCountsByEvent(
        profile.id,
        def.id,
        Math.min(...page.events.map((event) => event.id))
      )
    : {};
  return {
    days: projectSyncHistoryDays(page.events, {
      kind: def.kind,
      vocabulary: syncVocabularyForKind(def.kind),
      timeZone,
      provenanceCounts: counts,
      latestEventId: null,
      markLatest: false,
    }),
    nextBefore: page.nextBefore,
  };
}

// Collapsed ranges retain ids only. Resolve their full rows on demand, bounded and
// profile/provider scoped, so opening one range cannot become an arbitrary event
// reader and a closed range costs almost nothing on the client.
export async function loadSyncHistoryRuns(
  id: IntegrationId,
  eventIds: number[]
): Promise<SyncRunView[]> {
  const { profile } = await requireSession();
  const def = getIntegration(id);
  if (!def || !Array.isArray(eventIds) || eventIds.length > 1000) return [];
  const ids = [...new Set(eventIds)].filter(
    (eventId) => Number.isInteger(eventId) && eventId > 0
  );
  if (ids.length !== eventIds.length || ids.length === 0) return [];
  const events = getIntegrationSyncEventsByIds(profile.id, def.id, ids);
  const counts = provenanceCountsByEvent(profile.id, def.id, Math.min(...ids));
  const latest = getLatestSyncEvent(profile.id, def.id);
  const context = {
    vocabulary: syncVocabularyForKind(def.kind),
    provenanceCounts: counts,
    latestEventId: latest?.id ?? null,
  };
  return events.map((event) => projectSyncRun(event, context));
}

// THE "Sync now" action (#208, unified in #1772, made generic in #2040). There used
// to be four of these — one per provider — with an identical skeleton: authorize,
// run, map "not connected" to a sentence, fan out revalidatePath over a hand-written
// list, then assemble a parts[] message. Only the last of those was ever
// provider-specific, and it now lives beside the provider's runner
// (lib/integrations/pull-runners.ts); the routes a run feeds are declared in the
// registry's pull facet.
//
// Runs the SAME idempotent pull the hourly tick runs — a manual tap just advances the
// same rolling window — and returns a result the button surfaces inline instead of
// navigating with ?error=.
export async function syncNow(id: IntegrationId): Promise<SyncNowResult> {
  const { profile } = await requireWriteAccess();
  const def = getPullIntegration(id);
  const runner = def && getPullRunner(id);
  if (!def || !runner) {
    return { status: "error", message: "That source can't be synced by hand." };
  }
  const blocked = runner.blockedReason?.(profile.id);
  if (blocked) return { status: "error", message: blocked };

  try {
    const res = await runner.run(profile.id);
    if ("error" in res && typeof res.error === "string") {
      const message =
        res.error === "not connected"
          ? `Connect ${def.name} first, then sync.`
          : `Sync failed: ${res.error}`;
      log.error("sync-now failed", { provider: id, error: res.error });
      return { status: "error", message };
    }
    revalidateRoute(def.pull.revalidates);
    return { status: "done", message: runner.describe(res) };
  } catch (err) {
    log.error("sync-now threw", { provider: id, err: String(err) });
    return { status: "error", message: "Couldn't sync. Try again." };
  }
}
