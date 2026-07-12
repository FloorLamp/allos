import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 023 (issues #507/#508/#509): the re-import tombstone + its honest sync-
// event accounting.
//
// The user-edit lock (#133) stops a resync from CLOBBERING a hand-corrected imported
// row, but a MERGE or DELETE of a source-owned row got only a code comment, not a
// mechanism: the next rolling-window resync looks the row up by its natural key, finds
// nothing, and re-inserts it — resurrecting a merged-away duplicate or a deleted row.
// This adds the missing third lock:
//
//   • import_tombstones — a small profile-owned holding table keyed on
//     (profile_id, target_table, natural_key). A merge/delete of a source-owned row
//     records its natural key here; every keyed upsert (lib/integrations/normalize.ts)
//     consults it and skips the re-insert; undo of the merge/delete removes it. The
//     natural_key mirrors each table's upsert dedup key (see tombstone-keys.ts):
//     activities/medical_records by external_id, body_metrics by (date, source),
//     metric_samples by (metric, source, start, end), hr_minutes by (ts, source).
//
//   • integration_sync_events.suppressed — a nullable count column so a tombstone-
//     skipped re-insert is accounted for honestly (no silent cap): the Review feed
//     shows "N suppressed" instead of the row vanishing from the received/written
//     split.
//
// Pure additive DDL: a CREATE TABLE IF NOT EXISTS + an ADD COLUMN guarded on
// PRAGMA table_info, so a fresh DB and an already-converged one both end identical and
// the non-version-gated migrate() wrapper replays it as a no-op. Determinism (spec):
// reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS import_tombstones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          -- The keyed-upsert table this tombstone suppresses a re-insert into:
          -- 'activities' | 'body_metrics' | 'medical_records' | 'metric_samples' | 'hr_minutes'.
          target_table TEXT NOT NULL,
          -- The table's natural upsert key, normalized by lib/integrations/tombstone-keys.ts.
          natural_key TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
     CREATE UNIQUE INDEX IF NOT EXISTS idx_import_tombstones_key
          ON import_tombstones(profile_id, target_table, natural_key);`
  );

  if (!columnNames(db, "integration_sync_events").has("suppressed")) {
    db.exec(
      `ALTER TABLE integration_sync_events ADD COLUMN suppressed INTEGER;`
    );
  }
}

export const migration: Migration = {
  id: 23,
  name: "023-import-tombstones",
  up,
};
