// Low-supply nudge for SHARED supply pools (issue #1374) — the pooled twin of
// ./refill.ts.
//
// THE CONSTRAINT: one bottle must never produce N notifications. The per-item nudge
// runs inside the per-profile tick loop with a per-profile marker, so a bottle
// duplicated across three members nudged three times. A pool is ONE subject, so this
// pass runs ONCE per tick (globally, after the profile loop), keyed on the pool:
//
//   • dedup marker  — `notify_last_pool_refill_<poolId>` in the GLOBAL settings tier
//     (a pool has no owning profile; a per-profile marker would re-open the episode
//     once per member). Same "once per low-supply EPISODE" semantics as the per-item
//     nudge, self-healing per #325 — the sweep reads the FULL live marker set, so a
//     marker whose pool was deleted or untracked is cleared regardless.
//   • suppression   — the pool's `pool-refill:<poolId>` key on the shared findings bus.
//     The bus table is profile-scoped, so a linked member's dismissal is stored on
//     THEIR bus; the PUSH treats ANY linked member's active suppression as freezing the
//     episode ("I ordered it" is a fact about the BOTTLE, not about the viewer, so one
//     member acting on it must stop everyone's phone buzzing). The in-app row stays
//     per-viewer — a passive list entry each member clears for themselves.
//   • delivery      — login-scoped fan-out (#1072). dispatch(profileId) already reaches
//     every login that MANAGES that profile, deduped by chat id; planPoolDispatchProfiles
//     (pure) picks the minimum set of linked profiles that reaches every managing login
//     without pinging the same caregiver twice.
//
// Timing: the pass is gated to the WAKING WINDOW of the pool's earliest linked profile
// (the #378 humane-hour hold the per-item nudge gets), and the marker value is that
// profile's local date. A refill nudge is a non-time-critical episode nudge — it must
// never fire at the 3am date rollover.

import {
  getPoolView,
  listPoolViews,
  poolPushes,
  type PoolView,
} from "../queries/intake";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  planPoolRefillNudges,
  planPoolDispatchProfiles,
  poolRefillSignalKey,
  poolRefillMarkerKey,
  poolRefillIdFromMarker,
  POOL_REFILL_MARKER_PREFIX,
  type PoolRefillCandidate,
} from "../refill-nudge";
import { SUPPLIES_HREF } from "../hrefs";
import {
  getSetting,
  setSetting,
  deleteSetting,
  getSettingKeysWithPrefix,
  getPublicUrl,
} from "../settings";
import { managingLoginIdsForProfile } from "./managing-logins";
import { dispatch } from "./index";
import type { NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

interface LowPool {
  id: number;
  name: string;
  daysLeft: number;
}

// The pooled refill message. It names the BOTTLE, not a person — the whole point is
// that no single member owns it — and says how many people draw from it so the reader
// knows why it arrived on their phone. One deep link to the cabinet (the actuator for a
// refill is a quantity form, which a button handles badly — the ./refill.ts posture).
export function renderPoolRefillMessage(
  pools: readonly LowPool[],
  memberCounts: ReadonlyMap<number, number>,
  deepLinkBase = ""
): NotificationMessage {
  const head =
    pools.length === 1
      ? pools[0].name
      : `${pools.length} shared bottles running low`;
  const lines = pools.map((p) => {
    const n = memberCounts.get(p.id) ?? 0;
    const who = n > 1 ? ` · shared by ${n} people` : "";
    return `• ${p.name}: ≈${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left${who}`;
  });
  const base = deepLinkBase.replace(/\/$/, "");
  return {
    title: `🔄 Shared supply running low: ${head}`,
    body: `The household medicine cabinet is running low:\n${lines.join("\n")}`,
    actions: base
      ? [{ label: "Open the medicine cabinet", url: `${base}${SUPPLIES_HREF}` }]
      : [],
    kind: "refill",
  };
}

// Whether ANY linked member has an active suppression for this pool's finding key.
// Per-viewer dismissal in-app, pool-wide freeze on the push — see the header.
function poolSuppressed(
  pool: PoolView,
  dateFor: (p: number) => string
): boolean {
  const key = poolRefillSignalKey(pool.id);
  const seen = new Set<number>();
  for (const m of pool.members) {
    if (seen.has(m.profileId)) continue;
    seen.add(m.profileId);
    const rec = getFindingSuppressions(m.profileId).get(key);
    if (rec != null && isSuppressed(rec, dateFor(m.profileId))) return true;
  }
  return false;
}

// Run the shared-pool low-supply pass. GLOBAL — call it once per tick, not per profile.
// `dateFor` resolves a profile-local date (the tick passes today()); `wakingFor` answers
// whether it is currently inside that profile's waking window. Both are injected so this
// module stays free of the tick's scheduling internals and is drivable from the DB tier.
// Returns whether any send failed (folded into the tick's exit code). Never throws for
// an ordinary send failure.
export async function runPoolRefills(
  dateFor: (profileId: number) => string,
  wakingFor: (profileId: number) => boolean
): Promise<{ failed: boolean }> {
  const pools = listPoolViews();
  const candidates: PoolRefillCandidate[] = pools.map((p) => ({
    id: p.id,
    name: p.name,
    daysLeft: p.daysLeft,
    // Tracked, never pushed (#1505): a bottle whose entire ACTIVE membership is
    // low-priority supplements drops out of the nudge (poolPushes). Any pushable
    // member keeps the pooled signal, so a shared warfarin bottle is never silenced
    // by someone else's optional-supplement link. Folding it into `low` also means a
    // live marker self-heals through planPoolRefillNudges' normal clear path.
    low: p.low && poolPushes(p.members),
  }));

  // The FULL set of live markers — not just the current candidates — so a marker whose
  // pool was deleted still reaches the self-healing clear (#325).
  const markedIds = getSettingKeysWithPrefix(POOL_REFILL_MARKER_PREFIX)
    .map(poolRefillIdFromMarker)
    .filter((id) => Number.isInteger(id) && id > 0);
  const byId = new Map(pools.map((p) => [p.id, p]));
  const suppressedIds = candidates
    .filter((c) => {
      const pool = byId.get(c.id);
      return pool != null && poolSuppressed(pool, dateFor);
    })
    .map((c) => c.id);

  const { toSend, toClear } = planPoolRefillNudges(
    candidates,
    markedIds,
    suppressedIds
  );

  // End recovered/deleted episodes first — cheap, and never depends on a send.
  for (const id of toClear) deleteSetting(poolRefillMarkerKey(id));
  if (toSend.length === 0) return { failed: false };

  let anyFailed = false;
  for (const low of toSend) {
    const pool = byId.get(low.id);
    if (!pool || pool.members.length === 0) continue;
    // Hold the nudge to a humane hour (#378) in the EARLIEST linked profile's zone; the
    // marker value is that profile's local date, so "one episode" is dated once.
    const anchorProfileId = Math.min(...pool.members.map((m) => m.profileId));
    if (!wakingFor(anchorProfileId)) continue;

    const targets = planPoolDispatchProfiles(
      [...new Set(pool.members.map((m) => m.profileId))].map((profileId) => ({
        profileId,
        loginIds: managingLoginIdsForProfile(profileId),
      }))
    );
    if (targets.length === 0) {
      log.info("pool refill nudge skipped: no managing login", {
        pool: low.id,
      });
      continue;
    }

    const msg = renderPoolRefillMessage(
      [low],
      new Map([[low.id, pool.members.length]]),
      getPublicUrl()
    );
    let delivered = false;
    let attempted = false;
    for (const profileId of targets) {
      const results = await dispatch(profileId, msg);
      if (results.length === 0) continue; // no channel configured for this branch
      attempted = true;
      if (results.some((r) => r.ok)) delivered = true;
      if (results.some((r) => !r.ok)) anyFailed = true;
    }
    if (!attempted) {
      // No channel anywhere — leave the marker unset so it can send once configured.
      log.info("pool refill nudge skipped: no channel", { pool: low.id });
      continue;
    }
    if (delivered) {
      setSetting(poolRefillMarkerKey(low.id), dateFor(anchorProfileId));
      log.info("pool refill nudge sent", {
        pool: low.id,
        name: low.name,
        daysLeft: low.daysLeft,
        profiles: targets.length,
      });
    }
  }
  return { failed: anyFailed };
}

// Whether a pool currently holds a live low-supply episode marker — read by the DB-tier
// test (and available to any future surface) without spelling the key inline.
export function poolRefillMarker(supplyId: number): string | undefined {
  return getSetting(poolRefillMarkerKey(supplyId));
}

// Re-exported for callers that want one pool's resolved view alongside the nudge.
export { getPoolView };
