import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2878 completes the #2487 vocabulary change at the persistence boundary.
// Integration registry ids are sources, not healthcare providers. Each rebuild is
// value-preserving and keeps the table's keys, foreign keys, row ids, and sequence.

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      ({ name }) => name
    )
  );
}

function sequence(db: Database.Database, table: string): number | undefined {
  return (
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as
      { seq: number } | undefined
  )?.seq;
}

function restoreSequence(
  db: Database.Database,
  table: string,
  prior: number | undefined
): void {
  if (prior == null) return;
  const current = sequence(db, table);
  if (current == null) {
    db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)").run(
      table,
      prior
    );
  } else if (current < prior) {
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(
      prior,
      table
    );
  }
}

function rebuildConnections(db: Database.Database): void {
  if (!columns(db, "integration_connections").has("provider")) return;
  db.exec(`
    CREATE TABLE integration_connections__new_2878 (
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      source_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disconnected',
      config TEXT,
      last_sync_at TEXT,
      last_sync_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      refresh_claimed_at TEXT,
      PRIMARY KEY (profile_id, source_id)
    );
    INSERT INTO integration_connections__new_2878
      (profile_id, source_id, status, config, last_sync_at, last_sync_summary,
       created_at, updated_at, refresh_claimed_at)
      SELECT profile_id, provider, status, config, last_sync_at, last_sync_summary,
             created_at, updated_at, refresh_claimed_at
        FROM integration_connections;
    DROP TABLE integration_connections;
    ALTER TABLE integration_connections__new_2878 RENAME TO integration_connections;
  `);
}

function rebuildSyncEvents(db: Database.Database): void {
  if (!columns(db, "integration_sync_events").has("provider")) return;
  const prior = sequence(db, "integration_sync_events");
  db.exec(`
    CREATE TABLE integration_sync_events__new_2878 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      source_id TEXT NOT NULL,
      at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      window_start TEXT,
      window_end TEXT,
      received INTEGER,
      written INTEGER,
      skipped INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      inserted INTEGER,
      updated INTEGER,
      unchanged INTEGER,
      raw_ref TEXT,
      suppressed INTEGER,
      edited INTEGER,
      details TEXT,
      portal_id INTEGER REFERENCES portals(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES portal_accounts(id) ON DELETE SET NULL,
      patient_label TEXT
    );
    INSERT INTO integration_sync_events__new_2878
      (id, profile_id, source_id, at, ok, window_start, window_end, received,
       written, skipped, error, created_at, inserted, updated, unchanged, raw_ref,
       suppressed, edited, details, portal_id, account_id, patient_label)
      SELECT id, profile_id, provider, at, ok, window_start, window_end, received,
             written, skipped, error, created_at, inserted, updated, unchanged,
             raw_ref, suppressed, edited, details, portal_id, account_id,
             patient_label
        FROM integration_sync_events;
    DROP TABLE integration_sync_events;
    ALTER TABLE integration_sync_events__new_2878 RENAME TO integration_sync_events;
    CREATE INDEX idx_sync_events_profile_source_at
      ON integration_sync_events(profile_id, source_id, at);
    CREATE INDEX idx_sync_events_identity
      ON integration_sync_events(portal_id, account_id, patient_label, at);
  `);
  restoreSequence(db, "integration_sync_events", prior);
}

function rebuildBackfillJobs(db: Database.Database): void {
  if (!columns(db, "integration_backfill_jobs").has("provider")) return;
  const prior = sequence(db, "integration_backfill_jobs");
  db.exec(`
    CREATE TABLE integration_backfill_jobs__new_2878 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      item_noun TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('queued','running','paused','completed','failed')),
      total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
      completed_items INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
      failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      active_seconds REAL NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
      started_at TEXT,
      retry_after_at TEXT,
      finished_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id, source_id, kind)
    );
    INSERT INTO integration_backfill_jobs__new_2878
      (id, profile_id, source_id, kind, label, item_noun, status, total_items,
       completed_items, failed_items, request_count, active_seconds, started_at,
       retry_after_at, finished_at, error, created_at, updated_at)
      SELECT id, profile_id, provider, kind, label, item_noun, status, total_items,
             completed_items, failed_items, request_count, active_seconds,
             started_at, retry_after_at, finished_at, error, created_at, updated_at
        FROM integration_backfill_jobs;
    DROP TABLE integration_backfill_jobs;
    ALTER TABLE integration_backfill_jobs__new_2878 RENAME TO integration_backfill_jobs;
    CREATE INDEX idx_integration_backfill_jobs_profile_source
      ON integration_backfill_jobs(profile_id, source_id, updated_at DESC);
    CREATE INDEX idx_integration_backfill_jobs_resume
      ON integration_backfill_jobs(status, retry_after_at);
  `);
  restoreSequence(db, "integration_backfill_jobs", prior);
}

function rebuildStreamFrontiers(db: Database.Database): void {
  if (!columns(db, "stream_frontiers").has("provider")) return;
  const prior = sequence(db, "stream_frontiers");
  db.exec(`
    CREATE TABLE stream_frontiers__new_2878 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      frontier_at TEXT,
      advanced_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      syncs_since_advance INTEGER NOT NULL DEFAULT 0
        CHECK (syncs_since_advance >= 0),
      UNIQUE(profile_id, source_id, stream)
    );
    INSERT INTO stream_frontiers__new_2878
      (id, profile_id, source_id, stream, frontier_at, advanced_at, observed_at,
       syncs_since_advance)
      SELECT id, profile_id, provider, stream, frontier_at, advanced_at,
             observed_at, syncs_since_advance
        FROM stream_frontiers;
    DROP TABLE stream_frontiers;
    ALTER TABLE stream_frontiers__new_2878 RENAME TO stream_frontiers;
  `);
  restoreSequence(db, "stream_frontiers", prior);
}

export function up(db: Database.Database): void {
  rebuildConnections(db);
  rebuildSyncEvents(db);
  rebuildBackfillJobs(db);
  rebuildStreamFrontiers(db);
}

export const migration: Migration = {
  name: "20260814-integration-source-id",
  up,
};
