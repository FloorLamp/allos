import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 110 (issue #1333, deferred parts 1-2 of #1212): a per-row provenance
// store for integration syncs. Each keyed upsert already computes a per-row
// disposition (classifyUpsert/tallyUpsert, #14/#674); this table PERSISTS the
// user-meaningful ones so a Connected-sources event row can drill into WHICH
// records that sync inserted or updated, with row-level deep links to the records.
//
// Shape:
//   • event_id     → integration_sync_events(id) ON DELETE CASCADE. Retention is
//                    therefore inherited from the #388 sync-event sweep: when an
//                    aged event row is pruned (foreign_keys = ON at runtime, see
//                    lib/db.ts), its provenance rows cascade away with it. No
//                    separate sweep needed.
//   • target_table → 'activities' | 'body_metrics' | 'metric_samples' |
//                    'medical_records' (the user-meaningful tables; hr_minutes has
//                    no row id and activity_routes drills into its parent activity —
//                    both excluded per #1212). CHECK-pinned so a mis-routed target
//                    can't land.
//   • target_id    → the record's rowid in that table. POLYMORPHIC across four
//                    tables, so it carries NO foreign key (a single REFERENCES can't
//                    span tables); a target deleted after the fact simply resolves to
//                    no record at drill-in time.
//   • disposition  → 'inserted' | 'updated' only. 'unchanged' re-sends of the rolling
//                    window are deliberately NOT recorded — an hourly push re-states
//                    a 48h window whose rows are almost all unchanged, so persisting
//                    them would explode the table; recording only value-changing
//                    dispositions is both the issue's stated minimum and the natural
//                    volume cap.
//
// This is a CHILD table (no profile_id of its own): it reaches profile_id through
// the event join, per the profile-scoping test's child-table convention, exactly
// like exercise_sets → activities. It is therefore NOT in OWNED_TABLES; deleteProfile
// clears it explicitly through its parent (before the OWNED_TABLES sweep drops the
// integration_sync_events rows, which runs with foreign_keys OFF).
//
// CREATE ... IF NOT EXISTS keeps the migrate() replay a pure no-op.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_sync_rows (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
      target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records')),
      target_id    INTEGER NOT NULL,
      disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_integration_sync_rows_event
      ON integration_sync_rows(event_id);
  `);
}

export const migration: Migration = {
  id: 110,
  name: "110-integration-sync-rows",
  up,
};
