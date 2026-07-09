// Channel registry + dispatch. Adding a channel = implement NotificationChannel
// and list it here.

import { createLogger } from "../log";
import type { ChannelId, NotificationMessage } from "./types";
import { telegramChannel } from "./telegram";

const log = createLogger("notifications");

export function getChannels() {
  return [telegramChannel];
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
