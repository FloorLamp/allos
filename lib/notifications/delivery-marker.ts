// The DB read/write for the global delivery-health lifecycle marker (issue #942,
// migration 061). The pure set/clear/freeze DECISION is decideMarker
// (./delivery-status.ts); this module is the row I/O it drives, moved off the three
// legacy `notify_last_error*` settings keys onto the `notify_lifecycle` row so the
// marker is a first-class lifecycle state (one durable row keyed by a stable marker
// key). Global (no profile_id) — one shared bot, an instance-level signal.

import { db } from "../db";
import type { NotifyErrorMarker } from "./delivery-status";

// The stable lifecycle-marker key for the global delivery-health signal. A row exists
// (state='failing') only while a delivery channel is broken; healthy ⇒ no row.
export const DELIVERY_HEALTH_KEY = "delivery-health";

// The current failing delivery-health marker for the Settings surface, or null when
// healthy (no failing row). Same shape the old three-settings read returned.
export function readDeliveryMarker(): NotifyErrorMarker | null {
  const row = db
    .prepare(
      "SELECT channel, detail, at FROM notify_lifecycle WHERE key = ? AND state = 'failing'"
    )
    .get(DELIVERY_HEALTH_KEY) as
    | { channel: string | null; detail: string | null; at: string | null }
    | undefined;
  if (!row || !row.detail) return null;
  return { error: row.detail, at: row.at ?? "", channel: row.channel ?? "" };
}

// The channel of the currently-recorded failure, or "" when clear. Called INSIDE
// recordDeliveryOutcome's writeTx so the #192 channel-aware clear reads a consistent
// snapshot under the write lock.
export function readFailedChannel(): string {
  const row = db
    .prepare(
      "SELECT channel FROM notify_lifecycle WHERE key = ? AND state = 'failing'"
    )
    .get(DELIVERY_HEALTH_KEY) as { channel: string | null } | undefined;
  return row?.channel ?? "";
}

// SET the marker (upsert the single failing row). Called only from within the
// caller's writeTx.
export function setDeliveryFailure(
  channel: string,
  detail: string,
  at: string
): void {
  db.prepare(
    `INSERT INTO notify_lifecycle (key, state, channel, detail, at)
       VALUES (?, 'failing', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       state = 'failing',
       channel = excluded.channel,
       detail = excluded.detail,
       at = excluded.at`
  ).run(DELIVERY_HEALTH_KEY, channel, detail, at);
}

// CLEAR the marker (delete the row → healthy). Called only from within the caller's
// writeTx.
export function clearDeliveryMarker(): void {
  db.prepare("DELETE FROM notify_lifecycle WHERE key = ?").run(
    DELIVERY_HEALTH_KEY
  );
}
