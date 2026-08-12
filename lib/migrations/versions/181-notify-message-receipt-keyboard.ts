import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 181 — preserve the delivered dose claims after a callback rebuild.
//
// `notify_messages.keyboard` is deliberately mutable: since #2443 it follows the
// keyboard currently visible in Telegram, so reconciliation does not close a live
// correction row or collapse an expanded food nudge. A completed dose reminder still
// needs the ORIGINAL take/skip tokens, though, because those tokens identify the items
// whose final receipt must say "taken" or "skipped". Once a callback replaces them with
// correction-time buttons, Telegram offers no API for reading that original context
// back.
//
// Keep that delivered context in a separate immutable blob. Existing live pointers are
// backfilled from their current keyboard: it is the best context still available and
// preserves the pre-migration behaviour until those short-lived rows age out.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  const columns = columnNames(db, "notify_messages");
  if (columns.size === 0) return;
  if (!columns.has("receipt_keyboard")) {
    db.exec(`ALTER TABLE notify_messages ADD COLUMN receipt_keyboard TEXT`);
  }
  db.exec(
    `UPDATE notify_messages
        SET receipt_keyboard = keyboard
      WHERE receipt_keyboard IS NULL`
  );
}

export const migration: Migration = {
  id: 181,
  name: "181-notify-message-receipt-keyboard",
  up,
};
