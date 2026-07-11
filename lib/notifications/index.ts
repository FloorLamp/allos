// Channel registry + dispatch. Adding a channel = implement NotificationChannel
// and list it here.

import { db } from "../db";
import { createLogger } from "../log";
import { getSetting, setSetting } from "../settings";
import {
  profileMessagePrefix,
  type ChannelId,
  type NotificationMessage,
} from "./types";
import { telegramChannel } from "./telegram";
import { pushChannel } from "./push";
import { homeAssistantChannel } from "./home-assistant";
import { decideMarker, type NotifyErrorMarker } from "./delivery-status";

const log = createLogger("notifications");

// The "[Name] " title prefix for a profile's outbound message, computed the SAME
// way the hourly tick computes it at send time (issue #377): label the title with
// the profile's name when the instance tracks more than one profile, else "".
// Centralized here so the tick's initial send AND the Telegram tap-rebuild paths
// (telegram-callbacks.ts) draw the prefix from ONE computation — a rebuild must
// not silently drop the label a shared-chat message was sent with, which would
// make a dose reminder unattributable once its buttons are tapped (two kids'
// "[Ada]"/"[Ben] 💊 Morning supplements" both collapsing to a bare, identical
// "💊 Morning supplements"). `profiles` is a global (non-profile-scoped) table, so
// the count/name reads aren't profile-filtered — same basis as the tick's
// allProfiles() count.
export function prefixForProfile(profileId: number): string {
  const row = db
    .prepare("SELECT name FROM profiles WHERE id = ?")
    .get(profileId) as { name: string } | undefined;
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM profiles").get() as {
    c: number;
  };
  return profileMessagePrefix(row?.name ?? "", c);
}

// Global marker keys mirroring backup_last_* (#131): the last delivery failure,
// its ISO timestamp, and which channel failed. Cleared on the next all-OK send.
const NOTIFY_ERR_KEY = "notify_last_error";
const NOTIFY_ERR_AT_KEY = "notify_last_error_at";
const NOTIFY_ERR_CHANNEL_KEY = "notify_last_error_channel";

// The last persisted delivery failure for the Settings surface, or null when the
// most recent attempted send succeeded (marker cleared). Global, like the backup
// error — one shared bot serves every profile, so a revoked token / broken send
// is an instance-level signal.
export function getNotifyError(): NotifyErrorMarker | null {
  const error = getSetting(NOTIFY_ERR_KEY);
  if (!error) return null;
  return {
    error,
    at: getSetting(NOTIFY_ERR_AT_KEY) ?? "",
    channel: getSetting(NOTIFY_ERR_CHANNEL_KEY) ?? "",
  };
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
    // The channel of the currently-recorded failure, if any (empty when the
    // marker is clear or is a legacy value predating channel tracking).
    const prevFailedChannel = getSetting(NOTIFY_ERR_KEY)
      ? (getSetting(NOTIFY_ERR_CHANNEL_KEY) ?? "")
      : "";
    const decision = decideMarker(results, prevFailedChannel);
    if (decision.action === "set") {
      setSetting(NOTIFY_ERR_KEY, decision.failure.error);
      setSetting(NOTIFY_ERR_AT_KEY, new Date().toISOString());
      setSetting(NOTIFY_ERR_CHANNEL_KEY, decision.failure.channel);
    } else if (decision.action === "clear") {
      setSetting(NOTIFY_ERR_KEY, "");
      setSetting(NOTIFY_ERR_AT_KEY, "");
      setSetting(NOTIFY_ERR_CHANNEL_KEY, "");
    }
    // "keep" → leave the marker untouched.
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
