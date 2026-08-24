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
import { syncVocabularyForKind } from "@/lib/integrations/source-state";
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

// Read-only pagination for the source-owned ledger. The cursor is a complete,
// exclusive profile-local day, so a page boundary can never split a day's totals or
// hide one of its anomalies. Source/profile are both revalidated server-side.
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
// profile/source scoped, so opening one range cannot become an arbitrary event
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
// to be four of these — one per source — with an identical skeleton: authorize,
// run, map "not connected" to a sentence, fan out revalidatePath over a hand-written
// list, then assemble a parts[] message. Only the last of those was ever
// source-specific, and it now lives beside the source's runner
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
      // NO "Sync failed: " PREFIX (#3618), and it came out with the same change
      // that reworded the HTTP branch — never before it.
      //
      // The prefix existed because `res.error` used to be a fragment naming a path
      // and a status: "Sync failed: Oura /v2/usercollection/sleep request failed
      // (401)" is unreadable without it. Since #3592 the throw branch already
      // returned a whole house sentence, so the prefix had started doubling up
      // ("Sync failed: Couldn't reach Strava. Try again."); since #3618 every branch
      // that can REACH THIS LINE does, so it doubles up on all of them. Removing it
      // while the HTTP branch still read that way would have made the toast worse,
      // which is why the two halves are one change.
      //
      // "EVERY BRANCH THAT CAN REACH THIS LINE" is the honest scope, not "every
      // branch". Two runner returns are still raw fragments, and both are stopped
      // before here by something other than this file:
      //
      //   • weather-sync.ts's `"no home location"` — the weather runner declares a
      //     `blockedReason` (pull-runners.ts) that answers above, with a sentence
      //     that tells a person what to set. PINNED at the action tier
      //     (lib/__action_tests__/sync-now-message.actions.test.ts), because it is a
      //     guard that could be removed, not a structural impossibility.
      //   • strava-sync.ts's `"Strava read-request budget exhausted"` — it carries
      //     `status: 429`, which the list loop reads through `isPullRateLimited`
      //     first and turns into a TRUNCATED run, so it is never a `{ error }` at
      //     all. That one is structural: it would take a status change to surface.
      //
      // Recorded rather than smoothed over: if a third source ever returns a bare
      // fragment with no guard in front of it, this line ships it to a person as-is.
      //
      // The failure framing is not lost with it: the toast is rendered with
      // `tone: "error"` (components/SyncNowButton.tsx) off the `status` field
      // below, which is where that framing belongs.
      const message =
        res.error === "not connected"
          ? `Connect ${def.name} first, then sync.`
          : res.error;
      log.error("sync-now failed", { sourceId: id, error: res.error });
      return { status: "error", message };
    }
    revalidateRoute(def.pull.revalidates);
    return { status: "done", message: runner.describe(res) };
  } catch (err) {
    log.error("sync-now threw", { sourceId: id, err: String(err) });
    return { status: "error", message: "Couldn't sync. Try again." };
  }
}
