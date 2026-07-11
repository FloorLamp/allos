import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// migration 014 (issue #14): multi-source metric coexistence for hr_minutes.
//
// hr_minutes was keyed PRIMARY KEY (profile_id, ts) — the ONE metric store whose
// natural key still dropped `source` (metric_samples gained source in its unique
// key earlier; body_metrics has keyed on (profile_id, date, source) since #133).
// With a second per-minute HR writer (a direct vendor integration alongside the
// Health Connect push), the two writers would silently clobber each other's
// buckets on every rolling-window re-push. This rebuild adds `source` to the key
// so concurrent sources coexist, while a re-push from the SAME source still
// replaces its own bucket (idempotent — see upsertHrMinutes in
// lib/integrations/normalize.ts, updated alongside this migration).
//
// `source` also becomes NOT NULL (a key column must be reliably comparable):
// every historical writer was the Health Connect ingest, so existing NULLs — if
// any — are backfilled to 'health-connect'. The DEFAULT keeps any raw INSERT
// without a source working.
//
// Standard create → copy → drop → rename rebuild (SQLite can't alter a PRIMARY
// KEY in place), matching migrations 006/011. The runner (and the migrate() test
// wrapper) applies migrations with foreign_keys OFF, so dropping the old table is
// safe. The old key was UNIQUE on (profile_id, ts), so the copy cannot conflict
// under the wider key.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an
// already-converged DB, so the rebuild is guarded by a sentinel read off the live
// schema (`source` already part of the PRIMARY KEY → no-op). Production runs it
// exactly once behind the user_version gate. Determinism: reads only the DB and
// its own constants.

// True when hr_minutes already carries `source` as a PRIMARY KEY column.
function sourceInPrimaryKey(db: Database.Database): boolean {
  const cols = db.prepare(`PRAGMA table_info(hr_minutes)`).all() as {
    name: string;
    pk: number;
  }[];
  return cols.some((c) => c.name === "source" && c.pk > 0);
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    if (sourceInPrimaryKey(db)) return; // already converged (replay)
    db.exec(`
      CREATE TABLE hr_minutes_013_new (
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        ts TEXT NOT NULL,                                 -- YYYY-MM-DDTHH:MM profile-local at ingest (no zone stored — see #94)
        bpm REAL NOT NULL,                                -- count-weighted average
        bpm_min REAL,
        bpm_max REAL,
        n INTEGER NOT NULL,                               -- samples in bucket (for weighted merge)
        source TEXT NOT NULL DEFAULT 'health-connect',
        PRIMARY KEY (profile_id, ts, source)
      );
      INSERT INTO hr_minutes_013_new (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
        SELECT profile_id, ts, bpm, bpm_min, bpm_max, n, COALESCE(source, 'health-connect')
          FROM hr_minutes;
      DROP TABLE hr_minutes;
      ALTER TABLE hr_minutes_013_new RENAME TO hr_minutes;
      CREATE INDEX IF NOT EXISTS idx_hr_minutes_day ON hr_minutes(profile_id, substr(ts,1,10));
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 14,
  name: "014-hr-minutes-per-source",
  up,
};
