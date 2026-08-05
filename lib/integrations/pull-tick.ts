import { db } from "@/lib/db";
import { createLogger } from "@/lib/log";
import { getConnection } from "./connections";
import { getIntegration } from "./registry";
import { pullRunners } from "./pull-runners";
import {
  pullCadenceMinutes,
  shouldPollNow,
  type PollDecision,
} from "./pull-cadence";
import type { IntegrationId } from "@/lib/types";

// THE TICK'S PULL PASS (#2121 step 1). One profile's connected pull providers, polled
// at each provider's DECLARED cadence rather than once per tick.
//
// WHY THIS IS A lib MODULE AND NOT A BLOCK IN scripts/notify.ts. It used to be the
// latter, and the tick was therefore the only thing that could exercise it — the loop
// that decides how many external API calls the instance makes had no DB-tier test at
// all. Moving it here is what lets "two ticks in one hour poll a provider once" be an
// assertion instead of a claim. Auth-blind like every other lib write core: it takes
// `profileId` first and never imports lib/auth; the tick resolved the profile.
//
// WHAT IS GUARDED AND WHAT IS NOT. Only the SCHEDULED pass. A person pressing "Sync
// now" goes through app/(app)/integrations/sync-actions.ts straight to the runner and
// is never held back by the cadence guard — the attention doctrine's rule that the
// system may reduce its own contact but never overrule a user's own action applies to
// outbound polling too, and "I just connected this, sync it" is the single most
// common reason anyone presses that button.
//
// THE LAST-RUN FACT IS NOT NEW STATE. Every pull already appends an
// integration_sync_events row per run — success or failure — so "when did we last
// call this provider for this profile" was already recorded, indexed
// (idx_sync_events_profile_provider_at) and retention-swept (#388). The guard reads
// it. Minting a `notify_*` marker or a new settings key for a fact the database
// already holds would have added a second source of truth to keep in step, and a
// send-marker registry entry for something that is not a send.

const log = createLogger("pull-tick");

// The most recent recorded ATTEMPT for one (profile, provider) — ok or failed, since
// both spent an API call. Profile-scoped; served by the (profile_id, provider, at)
// index, so this is one seek per provider per tick rather than a scan.
export function lastPullAttemptAt(
  profileId: number,
  provider: string
): string | null {
  const row = db
    .prepare(
      `SELECT at FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, provider) as { at: string } | undefined;
  return row?.at ?? null;
}

// Whether this provider may be polled for this profile now — the registry-declared
// cadence met with the recorded last attempt. Exported so an operator surface (or a
// test) can ask the question without running the pass.
export function pullDecision(
  profileId: number,
  provider: IntegrationId,
  now: Date
): PollDecision {
  return shouldPollNow({
    lastAttemptAt: lastPullAttemptAt(profileId, provider),
    now,
    cadenceMinutes: pullCadenceMinutes(getIntegration(provider)),
  });
}

export interface PullTickResult {
  // Providers whose runner actually ran this pass.
  polled: IntegrationId[];
  // Connected providers held back by their cadence window.
  skipped: IntegrationId[];
}

// Pull from a profile's connected pull-integrations, at most once per provider per
// cadence window. Best-effort: a sync failure must never affect the notification flow
// or the process exit code, and one provider throwing must not stop the next — which
// is why each run is isolated.
//
// This used to be four copy-pasted try/if(connected)/log blocks (#2040), then one
// registry-driven loop, and now that loop with the quota guard in it (#2121).
//
// `now` defaults to the REAL clock, deliberately. The cadence window is a
// duration/rate-limit question, and lib/clock.ts states plainly that its freeze seam
// covers date-derivation only and must never be used for durations or rate-limit
// windows. Sync-event stamps are written by SQLite's own `datetime('now')`, which the
// seam cannot reach either, so both sides of the comparison read the same real UTC
// clock. A caller that needs a deterministic instant passes one in.
export async function syncIntegrations(
  profileId: number,
  now: Date = new Date()
): Promise<PullTickResult> {
  const result: PullTickResult = { polled: [], skipped: [] };
  for (const runner of pullRunners()) {
    try {
      // Only a live connection syncs. Weather is gated the same way — its enable flag
      // IS its connection row — and runWeatherSync additionally no-ops without a home
      // location. Every pull is an idempotent rolling window, so re-running the
      // overlap when the window IS open is free.
      if (getConnection(profileId, runner.id)?.status !== "connected") continue;
      // The quota half of the decoupling. Checked BEFORE the runner, because the
      // point is to not make the call at all — a guard inside the runner would still
      // pay the credential refresh, and a refresh is itself an API call.
      const decision = pullDecision(profileId, runner.id, now);
      if (!decision.poll) {
        result.skipped.push(runner.id);
        continue;
      }
      result.polled.push(runner.id);
      const r = await runner.run(profileId);
      log.info(`${runner.id} sync`, { profile: profileId, ...(r as object) });
    } catch (e) {
      log.error(`${runner.id} sync failed`, {
        profile: profileId,
        err: e instanceof Error ? e : String(e),
      });
    }
  }
  return result;
}
