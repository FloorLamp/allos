import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 152 (issue #1913 item 4): the PROSE witness on a live-message pointer.
//
// #1779's pointer stores the delivered KEYBOARD, because a reconciler that removes
// exactly the resolved buttons has to know what the chat is showing and Telegram has no
// "read my message" API. The prose-claim class needs the same thing for the TEXT: to
// edit only when a re-render actually differs — the idempotence rule that keeps the
// sweep at zero Telegram calls in the steady state — it has to know what the delivered
// body said.
//
// A HASH, not the body. Change detection needs no content, and the pointer table has no
// business holding a second copy of a message full of health facts. It doubles as the
// compare-and-swap witness for a prose edit, the same role the keyboard blob plays for a
// keyboard edit (#1788): a keyboard-less digest's blob is "[]" before and after, so it
// cannot distinguish two overlapping ticks, while the hash changes on every real edit.
//
// Nullable and unbackfilled: a pointer recorded before this column simply never matches
// a re-render and is left exactly as delivered, which is the fail-safe direction every
// reconciler here takes.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "notify_messages").has("body_hash")) {
    db.exec(`ALTER TABLE notify_messages ADD COLUMN body_hash TEXT`);
  }
}

export const migration: Migration = {
  id: 152,
  name: "152-notify-message-prose",
  up,
};
