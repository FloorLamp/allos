import { db } from "@/lib/db";
import { createLogger } from "@/lib/log";
import { getConnection } from "./connections";
import { getIntegration } from "./registry";
import { pullRunners } from "./pull-runners";
import {
  pullCadenceMinutes,
  pullOffsetMinutes,
  shouldPollNow,
  type PollDecision,
} from "./pull-cadence";
import { getSetting } from "@/lib/settings/kv";
import type { IntegrationId } from "@/lib/types";
import { resumeDueIntegrationBackfills } from "./backfill-jobs";

// THE TICK'S PULL PASS (#2121 step 1). One profile's connected pull sources, polled
// at each source's DECLARED cadence rather than once per tick.
//
// WHY THIS IS A lib MODULE AND NOT A BLOCK IN scripts/notify.ts. It used to be the
// latter, and the tick was therefore the only thing that could exercise it — the loop
// that decides how many external API calls the instance makes had no DB-tier test at
// all. Moving it here is what lets "two ticks in one hour poll a source once" be an
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
// call this source for this profile" was already recorded, indexed
// (idx_sync_events_profile_provider_at) and retention-swept (#388). The guard reads
// it. Minting a `notify_*` marker or a new settings key for a fact the database
// already holds would have added a second source of truth to keep in step, and a
// send-marker registry entry for something that is not a send.

const log = createLogger("pull-tick");

// The most recent recorded ATTEMPT for one (profile, source) — ok or failed, since
// both spent an API call. Profile-scoped; served by the (profile_id, source, at)
// index, so this is one seek per source per tick rather than a scan.
export function lastPullAttemptAt(
  profileId: number,
  sourceId: string
): string | null {
  const row = db
    // #2487 boundary: `sourceId` in TS, the column is still named `provider`.
    .prepare(
      `SELECT at FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
        ORDER BY at DESC, id DESC
        LIMIT 1`
    )
    .get(profileId, sourceId) as { at: string } | undefined;
  return row?.at ?? null;
}

// THE WINDOW OFFSET SEED (#2567), resolved here because the pure decision cannot read
// a database.
//
// Three ingredients, each doing one job. `install_first_boot_at` — a global settings
// key `seedInstallMarker` already stamps once and never rewrites, so no new setting and
// no migration — is what de-herds ACROSS installs: without it, profile 1 + weather
// would hash to the same minute on every allos in the world, which is the herd the
// offset exists to leave. The profile and source ids spread an instance's own sources
// across the window rather than moving them together.
//
// A missing marker (a partial-schema harness, a database predating the boot task)
// degrades to a still-deterministic seed rather than to randomness: the offset must be
// STABLE above all, since an offset that moves is a window boundary that moves.
function pullOffsetSeed(profileId: number, sourceId: string): string {
  return `${getSetting("install_first_boot_at") ?? ""}|${profileId}|${sourceId}`;
}

// This (profile, source)'s window offset in whole minutes. Exported for the same
// reason `pullDecision` is: an operator surface — or a fixture that needs to place a
// second tick inside the SAME window — must be able to ask where this source's window
// boundary sits without re-deriving the seed.
export function pullOffsetFor(
  profileId: number,
  sourceId: IntegrationId
): number {
  return pullOffsetMinutes(
    pullOffsetSeed(profileId, sourceId),
    pullCadenceMinutes(getIntegration(sourceId))
  );
}

// Whether this source may be polled for this profile now — the registry-declared
// cadence met with the recorded last attempt. Exported so an operator surface (or a
// test) can ask the question without running the pass.
export function pullDecision(
  profileId: number,
  sourceId: IntegrationId,
  now: Date
): PollDecision {
  const cadenceMinutes = pullCadenceMinutes(getIntegration(sourceId));
  return shouldPollNow({
    lastAttemptAt: lastPullAttemptAt(profileId, sourceId),
    now,
    cadenceMinutes,
    // Shifts the WINDOW BOUNDARY off the epoch-aligned one, so the poll stops landing
    // on the first tick of the hour (#2567). Not a wait inside the window: the
    // once-per-window bound is untouched.
    offsetMinutes: pullOffsetFor(profileId, sourceId),
  });
}

export interface PullTickResult {
  // Sources whose runner actually ran this pass.
  polled: IntegrationId[];
  // Connected sources held back by their cadence window.
  skipped: IntegrationId[];
}

// Pull from a profile's connected pull-integrations, at most once per source per
// cadence window. Best-effort: a sync failure must never affect the notification flow
// or the process exit code, and one source throwing must not stop the next — which
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
  try {
    await resumeDueIntegrationBackfills(profileId, now);
  } catch (e) {
    log.error("integration backfill resume failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  }
  return result;
}
