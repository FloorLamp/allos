// Channel registry + dispatch. Adding a channel = implement NotificationChannel
// and list it here.

import { writeTx } from "../db";
import { createLogger } from "../log";
import { type ChannelId, type NotificationMessage } from "./types";
import { telegramChannel } from "./telegram";
import { pushChannel } from "./push";
import { homeAssistantChannel } from "./home-assistant";
import { decideMarker, type NotifyErrorMarker } from "./delivery-status";
import {
  readDeliveryMarker,
  readFailedChannel,
  setDeliveryFailure,
  clearDeliveryMarker,
} from "./delivery-marker";

const log = createLogger("notifications");

// Re-exported for the existing `from "@/lib/notifications"` import path. The
// derivation itself lives in ./attribution (issue #454) so the Telegram channel
// chokepoint can own applying it at the edit/rebuild boundary without importing
// index.ts (which would form a cycle). One computation, shared by the tick's send
// site and the callback rebuild, so a rebuilt shared-chat message can't drop the
// "[Name] " label it was sent with (#377/#429).
export { prefixForProfile } from "./attribution";

// The last persisted delivery failure for the Settings surface, or null when the
// most recent attempted send succeeded (marker cleared). Global, like the backup
// error — one shared bot serves every profile, so a revoked token / broken send
// is an instance-level signal. Now backed by the `notify_lifecycle` row (issue #942,
// migration 061) instead of three ad-hoc settings keys — same returned shape.
export function getNotifyError(): NotifyErrorMarker | null {
  return readDeliveryMarker();
}

// Fold a dispatch fan-out into the global delivery-health marker. Set it when any
// attempted channel failed; clear it when a healthy dispatch actually exercised the
// previously-failing channel; leave it untouched otherwise — nothing attempted (no
// configured channel), or a healthy dispatch that never touched the broken channel
// (#192: a Telegram-only profile must not clear a still-broken push recorded by a
// both-channels profile earlier in the same tick). Best-effort — a settings write
// must never turn a delivery into a throw, so failures are logged and swallowed.
function recordDeliveryOutcome(results: DispatchResult[]): void {
  try {
    // Read-decide-write in ONE immediate transaction (issue #468): the marker is a
    // single lifecycle row, written by BOTH the web app and the notify tick. Without
    // the write lock taken at BEGIN, a set from one process could interleave with a
    // clear from the other and — worse — feed the #192 channel-aware clear a stale
    // prevFailedChannel read a moment before another process rewrote it. writeTx makes
    // the read (the prior failed channel) and the row write atomic against the other
    // writer.
    writeTx(() => {
      // The channel of the currently-recorded failure, if any (empty when the
      // marker is clear).
      const prevFailedChannel = readFailedChannel();
      const decision = decideMarker(results, prevFailedChannel);
      if (decision.action === "set") {
        setDeliveryFailure(
          decision.failure.channel,
          decision.failure.error,
          new Date().toISOString()
        );
      } else if (decision.action === "clear") {
        clearDeliveryMarker();
      }
      // "freeze" → leave the row untouched.
    });
  } catch (e) {
    log.error("recording delivery outcome failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// The channels dispatch() fans a message out to. All are tried on every send; each
// gates itself via isConfigured(profileId), so an instance with only one set up
// silently uses just that one. NOTE the per-slot dedup in scripts/notify.ts is
// intentionally channel-AGNOSTIC: dispatch() delivers to every configured channel
// in a single call, so a profile with Telegram + push + Home Assistant enabled gets
// all three within the same tick; the marker ("delivered" = at least one channel ok)
// only guards against re-sending on later hours, never against multi-channel fan-out.
export function getChannels() {
  return [telegramChannel, pushChannel, homeAssistantChannel];
}

export interface DispatchResult {
  id: ChannelId;
  ok: boolean;
  error?: string;
}

// Send a message to every channel configured for `profileId`. One channel
// failing never blocks the others; returns a per-channel result so the caller
// (CLI) can set its exit code.
export async function dispatch(
  profileId: number,
  msg: NotificationMessage
): Promise<DispatchResult[]> {
  const channels = getChannels().filter((c) => c.isConfigured(profileId));
  if (channels.length === 0) {
    log.warn("no configured channels; nothing sent");
    return [];
  }
  const results = await Promise.all(
    channels.map(async (c): Promise<DispatchResult> => {
      try {
        await c.send(profileId, msg);
        log.info("sent", { channel: c.id, title: msg.title });
        return { id: c.id, ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log.error("send failed", { channel: c.id, error });
        return { id: c.id, ok: false, error };
      }
    })
  );
  // Persist the delivery-health marker so a broken bot token / chat id becomes
  // visible in Settings instead of only surfacing as a tick exit code (#131).
  recordDeliveryOutcome(results);
  return results;
}
