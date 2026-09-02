// The row I/O for the SCOPED delivery lifecycle (#2565 A) — one `notify_lifecycle` row
// per delivery owner, plus the read that folds them back into the #131 aggregate. The
// pure decisions (which state a row means, how failures fold) are in
// ./delivery-status.ts; this module only reads and writes.
//
// STORAGE. The #942 marker table, extended by migration 20260902-notify-lifecycle-owner
// with `owner_id`: a scoped row is keyed `delivery:<channel>:<owner>` and carries the
// channel, the owner id (a login for Telegram/Push/Email, a profile for Home Assistant),
// the state, the failure detail and the attempt instant. Nothing else — never a chat id,
// an address, a webhook URL or a secret: `detail` is the transport's error sentence, the
// same text the old global marker stored.
//
// THE LEGACY ROW SURVIVES AS THE HONEST FALLBACK. The pre-#2565 instance-wide row (key
// 'delivery-health', no owner) is not rewritten into owner rows — the migration cannot
// know WHOSE send failed, and inventing a per-owner state is the thing the ruling
// forbids. So the aggregate read prefers scoped failures and falls back to it, and the
// first scoped attempt on its channel (or a configuration write for that channel)
// retires it: from then on that channel's truth is the owner rows.
//
// EVERY WRITE IS BEST-EFFORT. Recording an outcome happens inside a send; a bookkeeping
// failure must never turn a delivered message into a failed one, so a throw here is
// logged and swallowed — the posture the old `recordDeliveryOutcome` fold had.

import { db, writeTx } from "../db";
import { instantNow } from "../clock";
import { createLogger } from "../log";
import {
  foldFailures,
  type DeliveryOutcomeRow,
  type NotifyErrorMarker,
  type ScopedFailure,
} from "./delivery-status";
import type { ChannelId } from "./types";

const log = createLogger("delivery-lifecycle");

// The pre-#2565 instance-wide marker's key (#942, migration 061).
export const LEGACY_DELIVERY_HEALTH_KEY = "delivery-health";

export function deliveryKey(channel: ChannelId, ownerId: number): string {
  return `delivery:${channel}:${ownerId}`;
}

export type DeliveryOutcome = { ok: true } | { ok: false; error: string };

export function outcomeOf(e: unknown): DeliveryOutcome {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

// Record ONE attempt's outcome for every owner it was addressed to. A shared Telegram
// chat lists every login mapped to it, so all of them read the send that reached their
// chat; a single-owner channel lists one. Called at the adapter's send seam — the one
// place that has the owner and the outcome together — and from dispatch() for a
// timed-out channel (#3057), whose owners the adapter names but never got to record.
export function recordDeliveryOutcome(
  channel: ChannelId,
  ownerIds: readonly number[],
  outcome: DeliveryOutcome
): void {
  if (ownerIds.length === 0) return;
  try {
    const at = instantNow();
    writeTx(() => {
      const upsert = db.prepare(
        `INSERT INTO notify_lifecycle (key, state, channel, owner_id, detail, at)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           state = excluded.state,
           detail = excluded.detail,
           at = excluded.at`
      );
      for (const ownerId of ownerIds) {
        upsert.run(
          deliveryKey(channel, ownerId),
          outcome.ok ? "delivering" : "failing",
          channel,
          ownerId,
          outcome.ok ? null : outcome.error,
          at
        );
      }
      retireLegacyRow(channel);
    });
  } catch (e) {
    log.error("recording delivery outcome failed", {
      channel,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// Run a send for `ownerIds` and record what it did, rethrowing so the caller's own
// failure posture (a channel-level throw for dispatch()) is unchanged.
export async function recordedSend<T>(
  channel: ChannelId,
  ownerIds: readonly number[],
  send: () => Promise<T>
): Promise<T> {
  try {
    const result = await send();
    recordDeliveryOutcome(channel, ownerIds, { ok: true });
    return result;
  } catch (e) {
    recordDeliveryOutcome(channel, ownerIds, outcomeOf(e));
    throw e;
  }
}

// A configuration write out-dates every outcome recorded under the old configuration:
// the row goes, and the owner reads Ready (or Not set up) until something is attempted
// again. Owner omitted ⇒ every owner on the channel (a bot-token or SMTP change reaches
// all of them). Runs inside the caller's settings transaction when there is one —
// writeTx nests — so config and lifecycle move together.
export function invalidateDeliveryOutcome(
  channel: ChannelId,
  ownerId?: number
): void {
  writeTx(() => {
    if (ownerId === undefined) {
      db.prepare(
        "DELETE FROM notify_lifecycle WHERE channel = ? AND owner_id IS NOT NULL"
      ).run(channel);
    } else {
      db.prepare("DELETE FROM notify_lifecycle WHERE key = ?").run(
        deliveryKey(channel, ownerId)
      );
    }
    retireLegacyRow(channel);
  });
}

// The pre-scoped aggregate row said "channel X failed" about nobody in particular; the
// first scoped fact about channel X supersedes it.
function retireLegacyRow(channel: ChannelId): void {
  db.prepare("DELETE FROM notify_lifecycle WHERE key = ? AND channel = ?").run(
    LEGACY_DELIVERY_HEALTH_KEY,
    channel
  );
}

// One owner's latest recorded attempt, or null when nothing has been attempted under
// the current configuration (Ready, once the strip knows the channel is set up).
export function readDeliveryOutcome(
  channel: ChannelId,
  ownerId: number
): DeliveryOutcomeRow | null {
  const row = db
    .prepare("SELECT state, detail, at FROM notify_lifecycle WHERE key = ?")
    .get(deliveryKey(channel, ownerId)) as
    | { state: string; detail: string | null; at: string | null }
    | undefined;
  if (!row) return null;
  return {
    state: row.state === "delivering" ? "delivering" : "failing",
    detail: row.detail,
    at: row.at ?? "",
  };
}

// The aggregate for Settings → Server: the fold over scoped failures, else the legacy
// instance-wide row while one still stands, else null.
export function readDeliveryMarker(): NotifyErrorMarker | null {
  const failing = db
    .prepare(
      "SELECT key, channel, detail, at FROM notify_lifecycle WHERE state = 'failing'"
    )
    .all() as (ScopedFailure & { key: string })[];
  const scoped = foldFailures(
    failing.filter((r) => r.key !== LEGACY_DELIVERY_HEALTH_KEY)
  );
  if (scoped) return scoped;
  const legacy = failing.find((r) => r.key === LEGACY_DELIVERY_HEALTH_KEY);
  return legacy?.detail
    ? { error: legacy.detail, at: legacy.at ?? "", channel: legacy.channel }
    : null;
}
