import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 041 (issue #797): turn intake_item_logs into a per-ADMINISTRATION
// ledger so PRN reality ("gave ibuprofen at 4pm, again at 10pm") is representable.
//
// The log was built for schedule adherence and structurally could not represent a
// PRN med taken several times a day:
//
//   • UNIQUE(dose_id, date) — at most ONE log row per dose per calendar day. A q6h
//     fever med (3–4 administrations/day) is unrepresentable.
//   • no real intake time — `taken_at` DEFAULTs to the tap moment, never the time
//     the dose was actually given (log a 4pm dose at 9pm → the row says 9pm).
//
// This migration rebuilds the table into an administrations ledger: one row per
// actual intake event.
//
//   • DROP UNIQUE(dose_id, date) — multiple administrations of one dose on one day
//     are now legal rows. Scheduled-adherence "was this dose resolved on day D?"
//     becomes a DERIVED view (an administration exists for that dose+day), and the
//     one-per-day idempotency the UNIQUE used to enforce MOVES INTO THE WRITE CORES:
//     markDoseTaken/applyDoseStatus keep it via an explicit exists-check inside
//     their existing IMMEDIATE writeTx (#468/#616 already serialize those), and the
//     new PRN logAdministration core carries its own short-window double-tap guard.
//   • ADD given_at — the real intake timestamp, user-suppliable (with a #614-style
//     window guard on the write path). Backfilled from taken_at for every existing
//     row (each legacy row is exactly one administration whose given time we best
//     know as its recorded taken_at), so migrated data reads identically.
//
// Everything else is carried across verbatim: dose_id/item_id/date, the amount
// snapshot (#5), the skip status + reason (#232). The skip ledger, dose retirement
// (#232), escalation keys, and in-flight Telegram dose ids are untouched — buttons
// still resolve by dose id; only the insert semantics change underneath.
//
// A rebuild is required because SQLite cannot DROP a table constraint in place. This
// follows the documented create-scratch → copy → drop → rename pattern (matching
// migrations 006/011). The runner (and the migrate() test wrapper) apply every
// migration with foreign_keys DISABLED, so dropping intake_item_logs — a FK-child of
// intake_item_doses/intake_items, and a parent of nothing — does not cascade, and a
// child FK referencing a table BY NAME follows the rename onto the rebuilt table.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel (the given_at column
// present) — a second run is a pure no-op. Production runs it once behind the
// user_version gate. Determinism (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function rebuildLogs(db: Database.Database): void {
  if (tableSql(db, "intake_item_logs") === null) return; // absent (partial handle)
  if (columnNames(db, "intake_item_logs").has("given_at")) return; // converged
  db.exec(`
    CREATE TABLE intake_item_logs__new041 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dose_id INTEGER NOT NULL REFERENCES intake_item_doses(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES intake_items(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      taken_at TEXT NOT NULL DEFAULT (datetime('now')),
      given_at TEXT,
      amount TEXT,
      status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('taken','skipped')),
      skip_reason TEXT
    );
    INSERT INTO intake_item_logs__new041
      (id, dose_id, item_id, date, taken_at, given_at, amount, status, skip_reason)
      SELECT id, dose_id, item_id, date, taken_at, taken_at, amount, status, skip_reason
        FROM intake_item_logs;
    DROP TABLE intake_item_logs;
    ALTER TABLE intake_item_logs__new041 RENAME TO intake_item_logs;
    CREATE INDEX IF NOT EXISTS idx_intake_log_date ON intake_item_logs(date);
    -- The UNIQUE(dose_id, date) index that served the frequent per-(dose,date)
    -- resolution lookup is gone; a plain index keeps that read fast.
    CREATE INDEX IF NOT EXISTS idx_intake_log_dose_date
      ON intake_item_logs(dose_id, date);
  `);
}

export function up(db: Database.Database): void {
  // MUST run with foreign_keys disabled (the runner and migrate() both toggle it
  // off around application) so dropping the FK-child table does not misbehave. One
  // transaction for atomicity — nests as a SAVEPOINT under the runner's IMMEDIATE
  // txn, becomes the transaction under migrate()'s autocommit.
  const run = db.transaction(() => {
    rebuildLogs(db);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 41,
  name: "041-administration-ledger",
  up,
};
