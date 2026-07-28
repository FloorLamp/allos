import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 119: admit wellness-practice sessions into the per-row integration
// provenance ledger. `integration_sync_rows.target_table` is a polymorphic table
// discriminator pinned by a CHECK, so growing the vocabulary requires SQLite's
// create → copy → drop → rename rebuild rather than an in-place ALTER.
//
// Existing provenance rows are copied byte-for-byte, including their ids and
// timestamps. The table is a CHILD of integration_sync_events; the migration runner
// disables foreign-key enforcement around rebuild migrations, then restores it after
// the preserved event ids are back in place.
//
// Replay-safe: the converged CHECK contains the `practice_logs` sentinel, so the
// non-version-gated migration test wrapper can call up() again as a pure no-op.
const SENTINEL = "'practice_logs'";

function tableSql(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'integration_sync_rows'`
    )
    .get() as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db);
  if (sql === null || sql.includes(SENTINEL)) return;

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE integration_sync_rows__new119 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
        target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records','practice_logs')),
        target_id    INTEGER NOT NULL,
        disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO integration_sync_rows__new119
        (id, event_id, target_table, target_id, disposition, created_at)
        SELECT id, event_id, target_table, target_id, disposition, created_at
          FROM integration_sync_rows;

      DROP TABLE integration_sync_rows;
      ALTER TABLE integration_sync_rows__new119 RENAME TO integration_sync_rows;

      CREATE INDEX idx_integration_sync_rows_event
        ON integration_sync_rows(event_id);
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 119,
  name: "119-practice-sync-provenance",
  up,
};
