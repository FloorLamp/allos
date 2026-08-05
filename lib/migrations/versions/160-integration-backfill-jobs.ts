import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Durable, provider-neutral progress for optional history enrichment. A backfill is
// not a sync event: it can span many provider quota windows, survive navigation and
// process restarts, and updates already-imported rows rather than ingesting a new
// source window. One row per profile/provider/kind is the current durable checkpoint.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_backfill_jobs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      provider          TEXT NOT NULL,
      kind              TEXT NOT NULL,
      label             TEXT NOT NULL,
      item_noun         TEXT NOT NULL,
      status            TEXT NOT NULL
        CHECK (status IN ('queued','running','paused','completed','failed')),
      total_items       INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
      completed_items   INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
      failed_items      INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
      request_count     INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      active_seconds    REAL NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
      started_at        TEXT,
      retry_after_at    TEXT,
      finished_at       TEXT,
      error             TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, provider, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_backfill_jobs_profile_provider
      ON integration_backfill_jobs(profile_id, provider, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_backfill_jobs_resume
      ON integration_backfill_jobs(status, retry_after_at);
  `);
}

export const migration: Migration = {
  id: 160,
  name: "160-integration-backfill-jobs",
  up,
};
