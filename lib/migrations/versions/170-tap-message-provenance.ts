import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 170 (issue #2264): which MESSAGE'S tap wrote a one-tap ledger row.
//
// The eating/dose-time correction ride-along (#2019/#2020) renders a burst's chips on
// whichever chat keyboard is live — including keyboards belonging to OTHER messages
// about other bursts, which is the reported defect: a 7:30 "Morning food log" message
// grew the 12:42 midday burst's rows after a family rebuild, and its chips restamp the
// midday servings from the wrong message. The fix is provenance: record the originating
// message on the tap's own ledger row, and render a correction row only on the message
// that produced its burst.
//
// A nullable `notify_message_id INTEGER REFERENCES notify_messages(id) ON DELETE SET
// NULL` on BOTH one-tap ledgers — `food_log_events` (food/protein taps, #2019) and
// `intake_item_logs` (dose confirms, #2020) — because the two domains share the
// correction model and the defect symmetrically. `ON DELETE SET NULL` is the designed
// lifecycle, not a safety net: `notify_messages` rows are routinely closed and pruned
// (MESSAGE_POINTER_RETENTION_DAYS), and a burst whose message row is gone degrades to
// UNATTRIBUTED, which rides only the newest live message of its domain (#2264's
// sub-rule) — exactly like a web one-tap or an offline replay.
//
// NOT `meal_slot`, deliberately (recorded in #2264): the slot enum looks like ready-made
// attribution but answers a different question ("which meal does this serving belong
// to"), wins the window derivation unconditionally, and would freeze the meal against
// the very correction this feature exists to make — see telegram-callbacks' #2019 note.
//
// House rules: nullable REFERENCES column added via ALTER TABLE ADD COLUMN carries its
// FK (the migration-082 shape). Existing rows keep NULL — history is unattributed by
// construction, no backfill is possible or attempted. The two indexes exist for the FK's
// own sake: every `DELETE FROM notify_messages` (the prune sweep, a close claim) must
// resolve the child links without scanning two unbounded ledgers.
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  for (const table of ["food_log_events", "intake_item_logs"]) {
    if (!columnNames(db, table).has("notify_message_id")) {
      db.exec(
        `ALTER TABLE ${table}
           ADD COLUMN notify_message_id INTEGER REFERENCES notify_messages(id)
             ON DELETE SET NULL`
      );
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_food_log_events_notify_message
       ON food_log_events(notify_message_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_item_logs_notify_message
       ON intake_item_logs(notify_message_id)`
  );
}

export const migration: Migration = {
  id: 170,
  name: "170-tap-message-provenance",
  up,
};
