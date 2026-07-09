// Channel registry + dispatch. Adding a channel = implement NotificationChannel
// and list it here.

import { createLogger } from "../log";
import type { ChannelId, NotificationMessage } from "./types";
import { telegramChannel } from "./telegram";
import { pushChannel } from "./push";

const log = createLogger("notifications");

// The channels dispatch() fans a message out to. Both are tried on every send;
// each gates itself via isConfigured(profileId), so an instance with only one set
// up silently uses just that one. NOTE the per-slot dedup in scripts/notify.ts is
// intentionally channel-AGNOSTIC: dispatch() delivers to every configured channel
// in a single call, so a profile with BOTH Telegram and push enabled gets both
// within the same tick; the marker ("delivered" = at least one channel ok) only
// guards against re-sending on later hours, never against multi-channel fan-out.
export function getChannels() {
  return [telegramChannel, pushChannel];
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
  return Promise.all(
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
}
