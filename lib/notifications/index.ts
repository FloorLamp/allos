// Channel registry + dispatch. Adding a channel = implement NotificationChannel
// and list it here.

import { createLogger } from "../log";
import { type DispatchOptions, type NotificationMessage } from "./types";
import { telegramChannel } from "./telegram";
import { pushChannel } from "./push";
import { homeAssistantChannel } from "./home-assistant";
import { emailChannel } from "./email";
import type { NotifyErrorMarker } from "./delivery-status";
import {
  NOTIFICATION_DISPATCH_TIMEOUT_MS,
  settleWithinDeadline,
  type DispatchResult,
} from "./dispatch-deadline";
import { readDeliveryMarker, recordDeliveryOutcome } from "./delivery-marker";

const log = createLogger("notifications");

// Re-exported for the existing `from "@/lib/notifications"` import path. The
// derivation itself lives in ./attribution (issue #454) so the Telegram channel
// chokepoint can own applying it at the edit/rebuild boundary without importing
// index.ts (which would form a cycle). One computation, shared by the tick's send
// site and the callback rebuild, so a rebuilt shared-chat message can't drop the
// "[Name] " label it was sent with (#377/#429).
export { prefixForProfile } from "./attribution";
export type { DispatchOptions } from "./types";
// The shared whole-dispatch deadline and its typed timeout (#3057). Defined in
// ./dispatch-deadline (a light module, so the post-workout queue can derive its
// guard from the constant without pulling the channel stack); served from here
// for the ordinary `from "@/lib/notifications"` path.
export {
  NOTIFICATION_DISPATCH_TIMEOUT_MS,
  DispatchTimeoutError,
} from "./dispatch-deadline";
export type { DispatchResult } from "./dispatch-deadline";

// The aggregate delivery failure for Settings → Server, or null when no owner is
// failing. Since #2565 this is a FOLD over the scoped per-owner lifecycle rows
// (lib/notifications/delivery-marker.ts) rather than a fact of its own — the strip on
// Settings → Notifications reads the owner rows directly and never this.
export function getNotifyError(): NotifyErrorMarker | null {
  return readDeliveryMarker();
}

// The channels dispatch() fans a message out to. All are tried on every send; each
// gates itself via isConfigured(profileId), so an instance with only one set up
// silently uses just that one. NOTE the per-slot dedup in scripts/notify.ts is
// intentionally channel-AGNOSTIC: dispatch() delivers to every configured channel
// in a single call, so a profile with Telegram + push + Home Assistant enabled gets
// all three within the same tick; the marker ("delivered" = at least one channel ok)
// only guards against re-sending on later hours, never against multi-channel fan-out.
export function getChannels() {
  return [telegramChannel, pushChannel, homeAssistantChannel, emailChannel];
}

// Send a message to every channel configured for `profileId`. One channel
// failing never blocks the others; returns a per-channel result so the caller
// (CLI) can set its exit code. `opts` carries per-send routing a caller needs on top
// of the profile's own channels — today only the escalation's explicit caregiver chat
// (#1716) — so even a specially-routed safety message keeps the delivery accounting.
//
// BOUNDED (#3057): every channel starts concurrently and the whole fan-out
// resolves no later than NOTIFICATION_DISPATCH_TIMEOUT_MS. A channel still
// pending at the deadline gets an ok:false result with a typed timeout error —
// never success, never "nothing configured" — so the caller's ordinary
// channel-agnostic contact rule keeps working: any success stamps the slot
// marker once (the timed-out sibling is recorded as Erroring below, not
// replayed), and an all-fail leaves the marker unset for the retry band. The
// abandoned send keeps running — nothing here can cancel a transport in flight
// — but its late settlement is only logged; it cannot reach the returned
// results or re-run the marker fold.
export async function dispatch(
  profileId: number,
  msg: NotificationMessage,
  opts?: DispatchOptions
): Promise<DispatchResult[]> {
  const channels = getChannels().filter((c) => c.isConfigured(profileId, opts));
  if (channels.length === 0) {
    log.warn("no configured channels; nothing sent");
    return [];
  }
  const results = await settleWithinDeadline(
    channels.map((c) => ({
      id: c.id,
      promise: (async (): Promise<DispatchResult> => {
        try {
          await c.send(profileId, msg, opts);
          log.info("sent", { channel: c.id, title: msg.title });
          return { id: c.id, ok: true };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          log.error("send failed", { channel: c.id, error });
          return { id: c.id, ok: false, error };
        }
      })(),
    })),
    NOTIFICATION_DISPATCH_TIMEOUT_MS,
    (id, late) =>
      log.warn(
        "channel settled after the dispatch deadline; result discarded",
        {
          channel: id,
          ok: late.ok,
        }
      )
  );
  // Each channel recorded its owners' outcomes as it sent (#2565). The one outcome
  // no adapter can see is its own deadline: a channel still pending when the shared
  // deadline fired is Erroring for the owners it was addressing (#3057), recorded
  // here against the audience the adapter names. Its late settlement, if any,
  // records the real outcome over this one — the row is about the latest attempt.
  results.forEach((r, i) => {
    if (r.timedOut)
      recordDeliveryOutcome(r.id, channels[i].owners(profileId, msg, opts), {
        ok: false,
        error: r.error ?? "timed out",
      });
  });
  return results;
}
