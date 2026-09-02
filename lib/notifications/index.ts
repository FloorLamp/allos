// Channel registry + dispatch. Adding a channel = implement NotificationChannel
// and list it here.

import { writeTx } from "../db";
import { instantNow } from "../clock";
import { createLogger } from "../log";
import { type DispatchOptions, type NotificationMessage } from "./types";
import { telegramChannel } from "./telegram";
import { composeForSend } from "./compose";
import { pushChannel } from "./push";
import { homeAssistantChannel } from "./home-assistant";
import { emailChannel } from "./email";
import { decideMarker, type NotifyErrorMarker } from "./delivery-status";
import {
  NOTIFICATION_DISPATCH_TIMEOUT_MS,
  settleWithinDeadline,
  type DispatchResult,
} from "./dispatch-deadline";
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
        // `notify_lifecycle.at` is on the canonical stored-instant convention
        // (migration 167, #2233): the shape comes from lib/date.ts via the clock
        // seam, never from a hand-built `new Date().toISOString()` — which wrote
        // a third serialization (milliseconds + Z) into a schema that has two.
        setDeliveryFailure(
          decision.failure.channel,
          decision.failure.error,
          instantNow()
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
  // COMPOSED ONCE, HERE (#4538) — after the "is anything sending?" gate, so a profile
  // with no channel costs no reads. Attribution used to be applied by whichever caller
  // remembered to (eight of them did, the rest did not) while the callback rebuild
  // applied it unconditionally, so a rebuild could make the "[Name] " label appear on a
  // message that was sent without it. Every dispatch is an UNBIDDEN send, which is what
  // `telegram-nudge` means (#3087) — the on-demand surfaces go out through
  // `sendTelegramMessage` instead — so the origin is a property of the send path rather
  // than of each mint site.
  const composed = composeForSend(profileId, msg, "telegram-nudge");
  const results = await settleWithinDeadline(
    channels.map((c) => ({
      id: c.id,
      promise: (async (): Promise<DispatchResult> => {
        try {
          await c.send(profileId, composed, opts);
          log.info("sent", { channel: c.id, title: composed.title });
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
  // Persist the delivery-health marker so a broken bot token / chat id becomes
  // visible in Settings instead of only surfacing as a tick exit code (#131).
  recordDeliveryOutcome(results);
  return results;
}
