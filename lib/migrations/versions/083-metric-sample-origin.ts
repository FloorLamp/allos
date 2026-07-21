import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 083 (#1101/#1102): Health Connect's daily exporter snapshots keep a
// stable start while their end advances on every push, and one HC payload can carry
// overlapping records from several origin apps. Rebuild metric_samples so its
// natural key is (profile, metric, source, normalized origin, start), retaining only
// the latest-end legacy row in each old snapshot pileup. `origin` remains nullable;
// the expression index makes NULL compare as one stable no-origin identity.

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

function migrateMetricTombstones(db: Database.Database): void {
  const separator = String.fromCharCode(0x1f);
  const rows = db
    .prepare(
      `SELECT profile_id, natural_key FROM import_tombstones
        WHERE target_table = 'metric_samples'`
    )
    .all() as { profile_id: number; natural_key: string }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO import_tombstones
       (profile_id, target_table, natural_key, created_at)
     SELECT profile_id, target_table, ?, created_at
       FROM import_tombstones
      WHERE profile_id = ? AND target_table = 'metric_samples' AND natural_key = ?`
  );
  const remove = db.prepare(
    `DELETE FROM import_tombstones
      WHERE profile_id = ? AND target_table = 'metric_samples' AND natural_key = ?`
  );
  for (const row of rows) {
    const [metric, source, start] = row.natural_key.split(separator);
    if (!metric || !source || !start) continue;
    const next = [metric, source, "", start].join(separator);
    insert.run(next, row.profile_id, row.natural_key);
    if (next !== row.natural_key) {
      remove.run(row.profile_id, row.natural_key);
    }
  }
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    if (!columns(db, "metric_samples").has("origin")) {
      db.exec(`
        CREATE TABLE metric_samples_083_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          source TEXT NOT NULL,
          origin TEXT,
          metric TEXT NOT NULL,
          date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          value REAL NOT NULL,
          activity_external_id TEXT
        );

        INSERT INTO metric_samples_083_new
          (id, profile_id, source, origin, metric, date, start_time, end_time,
           value, activity_external_id)
        SELECT sample.id, sample.profile_id, sample.source, NULL, sample.metric,
               sample.date, sample.start_time, sample.end_time, sample.value,
               sample.activity_external_id
          FROM metric_samples AS sample
         WHERE NOT EXISTS (
           SELECT 1 FROM metric_samples AS newer
            WHERE newer.profile_id = sample.profile_id
              AND newer.metric = sample.metric
              AND newer.source = sample.source
              AND newer.start_time = sample.start_time
              AND (newer.end_time > sample.end_time
                   OR (newer.end_time = sample.end_time AND newer.id > sample.id))
         );

        DROP TABLE metric_samples;
        ALTER TABLE metric_samples_083_new RENAME TO metric_samples;
        CREATE UNIQUE INDEX idx_metric_samples_natural
          ON metric_samples(
            profile_id, metric, source, COALESCE(origin, ''), start_time
          );
        CREATE INDEX idx_metric_samples_md
          ON metric_samples(profile_id, metric, date);
        CREATE INDEX idx_metric_samples_end
          ON metric_samples(profile_id, metric, end_time);
        CREATE INDEX idx_metric_samples_activity
          ON metric_samples(profile_id, source, activity_external_id, metric)
          WHERE activity_external_id IS NOT NULL;
      `);
      migrateMetricTombstones(db);
    }

    if (!columns(db, "integration_sync_events").has("details")) {
      db.exec(`ALTER TABLE integration_sync_events ADD COLUMN details TEXT;`);
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 83,
  name: "083-metric-sample-origin",
  up,
};
