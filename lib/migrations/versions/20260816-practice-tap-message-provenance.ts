import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2875: which MESSAGE'S tap wrote a practice session row.
//
// Migration 170 gave `food_log_events` and `intake_item_logs` a `notify_message_id`
// so the #2019/#2020 time-correction rows could be BOUND to the message that
// produced their burst (#2264). Practices were the third domain to gain one-tap
// logging and never got the correction substrate at all, so they never got the
// column either. Adding the chips without it would make every practice burst
// UNATTRIBUTED — able to ride only the newest live message of its domain — which
// is precisely the defect #2264 fixed for the other two: a `/practice` list from
// this morning growing chips that restamp a sauna logged from the pace nudge two
// hours later.
//
// Exactly migration 170's shape, deliberately: a nullable
// `INTEGER REFERENCES notify_messages(id) ON DELETE SET NULL` added by ALTER TABLE
// ADD COLUMN (the migration-082 rule for a nullable FK), plus the index the FK
// itself needs — every `DELETE FROM notify_messages` (the prune sweep, a close
// claim) must resolve its children without scanning the practice ledger.
//
// `ON DELETE SET NULL` is the designed lifecycle rather than a safety net:
// `notify_messages` rows are routinely closed and pruned
// (MESSAGE_POINTER_RETENTION_DAYS), and a burst whose message row has gone
// degrades to unattributed, which is the same answer a web quick-sheet tap gets.
//
// Existing rows keep NULL. History is unattributed by construction — the message
// that produced a session logged before this column existed was never recorded, so
// there is nothing to backfill from and none is attempted.
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "practice_logs").has("notify_message_id")) {
    db.exec(
      `ALTER TABLE practice_logs
         ADD COLUMN notify_message_id INTEGER REFERENCES notify_messages(id)
           ON DELETE SET NULL`
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_practice_logs_notify_message
       ON practice_logs(notify_message_id)`
  );
}

export const migration: Migration = {
  name: "20260816-practice-tap-message-provenance",
  up,
};
