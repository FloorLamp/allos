import type Database from "better-sqlite3";
import { BACKFILL_OWNED_TABLES } from "../owned-tables";
import { tableColumns } from "./schema-utils";

// Multi-user (issue #67, Phase 2) profile_id machinery, extracted verbatim from
// lib/db.ts. Called from migrate() AFTER every per-profile table exists and after
// the addColumnIfMissing profile_id loop has run: backfill profile 1, rebuild the
// tables whose primary/unique key must gain profile_id, add `source` to the
// metric_samples key (#128), relax body_metrics.weight_kg (#120), then swap the
// profile-scoped indexes into place. All are idempotent + behavior-preserving.

// Backfill profile_id = 1 on every per-profile table (issue #67, Phase 2). Fresh
// DBs have no NULL rows (the column is born NOT NULL); this is for upgraded DBs,
// where addColumnIfMissing added a nullable column just above. Idempotent — only
// touches NULLs.
//
// Only runs — and only (re)creates profile 1 — when there are actually NULL rows
// to adopt. Once every DB has migrated, no NULL rows remain, so this is a no-op
// and, crucially, will NOT resurrect a profile 1 that an admin deliberately
// deleted (issue #67 deletion). The INSERT OR IGNORE guards the FK on the one
// pass where NULLs exist but profile 1 somehow doesn't.
export function backfillProfileIds(db: Database.Database) {
  // Derived from the shared owned-table source of truth: only the tables that
  // acquired profile_id via addColumnIfMissing can hold NULL rows to adopt.
  const OWNED = BACKFILL_OWNED_TABLES;
  const hasNulls = OWNED.some(
    (t) =>
      !!db.prepare(`SELECT 1 FROM ${t} WHERE profile_id IS NULL LIMIT 1`).get()
  );
  if (!hasNulls) return; // nothing to adopt — don't touch profiles

  const name = (process.env.ADMIN_USERNAME ?? "admin").trim() || "admin";
  db.prepare("INSERT OR IGNORE INTO profiles (id, name) VALUES (1, ?)").run(
    name
  );
  for (const t of OWNED) {
    db.exec(`UPDATE ${t} SET profile_id = 1 WHERE profile_id IS NULL`);
  }
}

// Rebuild a table under a busy-tolerant IMMEDIATE transaction. SQLite can't ALTER
// a table's primary/unique key, so the tables that must gain profile_id in their
// key are rebuilt: create <t>_new with the new shape, copy rows (assigning
// profile_id = 1), drop the old table, rename. `needsRebuild` is re-checked
// INSIDE the transaction because parallel `next build` workers race here — the
// loser sees the new shape already present and no-ops. DROP any stale _new table
// from a prior aborted attempt first. busy_timeout (set in createDb) makes
// IMMEDIATE wait out a competing writer; the retry loop is a final backstop.
function rebuildTable(
  db: Database.Database,
  newName: string,
  needsRebuild: () => boolean,
  body: () => void
) {
  if (!needsRebuild()) return;
  const tx = db.transaction(() => {
    if (!needsRebuild()) return; // lost the race — another worker rebuilt it
    db.exec(`DROP TABLE IF EXISTS ${newName}`);
    body();
  });
  for (let attempt = 0; ; attempt++) {
    try {
      tx.immediate();
      return;
    } catch (err) {
      // Another worker may have finished the rebuild between our check and BEGIN;
      // if the target now has the new shape, treat it as success.
      if (!needsRebuild()) return;
      if (attempt < 5 && /SQLITE_BUSY/i.test(String(err))) continue;
      throw err;
    }
  }
}

// Rebuild the five tables whose primary/unique key must gain profile_id (issue
// #67, Phase 2). No FK points at any of them, so dropping/renaming is safe under
// foreign_keys = ON. Each copies existing rows onto profile 1. Guards skip fresh
// DBs, which are already born with the new shape (see the CREATE blocks).
export function rebuildForProfileScoping(db: Database.Database) {
  // hr_minutes: PK ts → PK (profile_id, ts)
  rebuildTable(
    db,
    "hr_minutes_new",
    () => !tableColumns(db, "hr_minutes").includes("profile_id"),
    () => {
      db.exec(`
        CREATE TABLE hr_minutes_new (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          ts TEXT NOT NULL,
          bpm REAL NOT NULL,
          bpm_min REAL,
          bpm_max REAL,
          n INTEGER NOT NULL,
          source TEXT,
          PRIMARY KEY (profile_id, ts)
        );
        INSERT INTO hr_minutes_new (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
          SELECT 1, ts, bpm, bpm_min, bpm_max, n, source FROM hr_minutes;
        DROP TABLE hr_minutes;
        ALTER TABLE hr_minutes_new RENAME TO hr_minutes;
      `);
    }
  );

  // insights: UNIQUE(date) → UNIQUE(profile_id, date)
  rebuildTable(
    db,
    "insights_new",
    () => !tableColumns(db, "insights").includes("profile_id"),
    () => {
      db.exec(`
        CREATE TABLE insights_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          summary TEXT NOT NULL,
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (profile_id, date)
        );
        INSERT INTO insights_new (id, profile_id, date, summary, model, created_at)
          SELECT id, 1, date, summary, model, created_at FROM insights;
        DROP TABLE insights;
        ALTER TABLE insights_new RENAME TO insights;
      `);
    }
  );

  // metric_samples: UNIQUE(metric, start_time, end_time) →
  // UNIQUE(profile_id, metric, source, start_time, end_time). A pre-#67 (no
  // profile_id) DB jumps straight to the final #128 source-bearing key here, so
  // rebuildMetricSamplesSourceKey (which handles the intermediate profile_id-but-
  // no-source shape) then no-ops for this DB.
  rebuildTable(
    db,
    "metric_samples_new",
    () => !tableColumns(db, "metric_samples").includes("profile_id"),
    () => {
      db.exec(`
        CREATE TABLE metric_samples_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          source TEXT NOT NULL,
          metric TEXT NOT NULL,
          date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          value REAL NOT NULL,
          UNIQUE (profile_id, metric, source, start_time, end_time)
        );
        INSERT INTO metric_samples_new
          (id, profile_id, source, metric, date, start_time, end_time, value)
          SELECT id, 1, source, metric, date, start_time, end_time, value
          FROM metric_samples;
        DROP TABLE metric_samples;
        ALTER TABLE metric_samples_new RENAME TO metric_samples;
      `);
    }
  );

  // starred_biomarkers: PK canonical_name → PK (profile_id, canonical_name),
  // preserving COLLATE NOCASE on canonical_name.
  rebuildTable(
    db,
    "starred_biomarkers_new",
    () => !tableColumns(db, "starred_biomarkers").includes("profile_id"),
    () => {
      db.exec(`
        CREATE TABLE starred_biomarkers_new (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          canonical_name TEXT NOT NULL COLLATE NOCASE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, canonical_name)
        );
        INSERT INTO starred_biomarkers_new (profile_id, canonical_name, created_at)
          SELECT 1, canonical_name, created_at FROM starred_biomarkers;
        DROP TABLE starred_biomarkers;
        ALTER TABLE starred_biomarkers_new RENAME TO starred_biomarkers;
      `);
    }
  );

  // integration_connections: PK id (provider string) → PK (profile_id, provider).
  // The old column `id` holding the provider is renamed to `provider`.
  rebuildTable(
    db,
    "integration_connections_new",
    () => !tableColumns(db, "integration_connections").includes("provider"),
    () => {
      db.exec(`
        CREATE TABLE integration_connections_new (
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          provider TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'disconnected',
          config TEXT,
          last_sync_at TEXT,
          last_sync_summary TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, provider)
        );
        INSERT INTO integration_connections_new
          (profile_id, provider, status, config, last_sync_at, last_sync_summary,
           created_at, updated_at)
          SELECT 1, id, status, config, last_sync_at, last_sync_summary,
                 created_at, updated_at
          FROM integration_connections;
        DROP TABLE integration_connections;
        ALTER TABLE integration_connections_new RENAME TO integration_connections;
      `);
    }
  );
}

// Whether metric_samples' natural-key UNIQUE index already includes `source`. The
// key is a table-level UNIQUE constraint, so SQLite backs it with an auto-index
// (origin 'u'); we find the unique index that covers the (metric, start_time)
// natural key and report whether `source` is among its columns. Returns true when
// no such index exists (nothing to rebuild).
function metricSamplesKeyHasSource(db: Database.Database): boolean {
  // Table name interpolated (like tableColumns/columnNotNull) so the profile-
  // scoping source scanner sees a variable, not an owned-table literal, in this
  // PRAGMA — which legitimately touches metric_samples without a profile_id filter.
  const table = "metric_samples";
  const idxs = db.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
  }[];
  for (const idx of idxs) {
    if (!idx.unique) continue;
    const cols = (
      db.prepare(`PRAGMA index_info("${idx.name}")`).all() as { name: string }[]
    ).map((c) => c.name);
    // The natural-key unique index (not some other unique index) — identify it by
    // the metric + time-window columns it must span.
    if (cols.includes("metric") && cols.includes("start_time")) {
      return cols.includes("source");
    }
  }
  return true; // no natural-key unique index found — nothing to do
}

// Add `source` to the metric_samples unique key (#128) on DBs that already have
// the profile_id shape but whose key is the older UNIQUE(profile_id, metric,
// start_time, end_time) — so two providers reporting the same metric for the same
// window no longer silently overwrite each other. SQLite can't ALTER a unique
// constraint, so the table is rebuilt (the standard *_new pattern).
//
// No row de-collision is needed: the OLD key UNIQUE(profile_id, metric,
// start_time, end_time) is a STRICT SUBSET of the NEW key's columns, so any two
// rows that were distinct under the old key stay distinct under the new (wider)
// key, and the old key already forbade two rows equal on that tuple. Every
// existing row is therefore already unique under the new superset key, and the
// INSERT…SELECT copy cannot raise a UNIQUE violation.
export function rebuildMetricSamplesSourceKey(db: Database.Database) {
  rebuildTable(
    db,
    "metric_samples_new",
    () =>
      tableColumns(db, "metric_samples").includes("profile_id") &&
      !metricSamplesKeyHasSource(db),
    () => {
      db.exec(`
        CREATE TABLE metric_samples_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          source TEXT NOT NULL,
          metric TEXT NOT NULL,
          date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          value REAL NOT NULL,
          UNIQUE (profile_id, metric, source, start_time, end_time)
        );
        INSERT INTO metric_samples_new
          (id, profile_id, source, metric, date, start_time, end_time, value)
          SELECT id, profile_id, source, metric, date, start_time, end_time, value
          FROM metric_samples;
        DROP TABLE metric_samples;
        ALTER TABLE metric_samples_new RENAME TO metric_samples;
      `);
    }
  );
}

// Whether a column is declared NOT NULL. The table name is interpolated (like
// tableColumns/addColumnIfMissing) so the profile-scoping source scanner sees a
// variable, not an owned-table literal, in the prepared SQL.
function columnNotNull(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    notnull: number;
  }[];
  const col = cols.find((c) => c.name === column);
  return !!col && col.notnull === 1;
}

// Drop the NOT NULL on body_metrics.weight_kg (#120) so a weightless row (a
// vitals panel's resting HR or body-fat with no scale weight) can be stored.
// SQLite can't ALTER a column's nullability, so the table is rebuilt: create the
// new shape, copy every row, drop, rename. Guarded so fresh DBs (born nullable
// via CREATE TABLE) and already-migrated DBs no-op. Runs after profile_id/source
// exist; the index it drops with the table is recreated by swapProfileScopedIndexes.
export function relaxBodyMetricsWeightKg(db: Database.Database) {
  rebuildTable(
    db,
    "body_metrics_new",
    () => columnNotNull(db, "body_metrics", "weight_kg"),
    () => {
      db.exec(`
        CREATE TABLE body_metrics_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id),
          date TEXT NOT NULL,
          weight_kg REAL,
          body_fat_pct REAL,
          resting_hr INTEGER,
          notes TEXT,
          source TEXT
        );
        INSERT INTO body_metrics_new
          (id, profile_id, date, weight_kg, body_fat_pct, resting_hr, notes, source)
          SELECT id, profile_id, date, weight_kg, body_fat_pct, resting_hr, notes, source
          FROM body_metrics;
        DROP TABLE body_metrics;
        ALTER TABLE body_metrics_new RENAME TO body_metrics;
      `);
    }
  );
}

// Swap the profile-scoped indexes into place, after the profile_id column exists
// (upgraded DBs add it just above; fresh DBs are born with it). CREATE INDEX with
// IF NOT EXISTS can't redefine an existing index, so the old single-column ones
// are dropped by name first, then recreated as profile_id-leading composites. The
// external_id partial-unique indexes move from a global to a per-profile scope.
export function swapProfileScopedIndexes(db: Database.Database) {
  db.exec(`
    DROP INDEX IF EXISTS idx_activities_date;
    DROP INDEX IF EXISTS idx_weigh_date;
    DROP INDEX IF EXISTS idx_weigh_profile_date;
    DROP INDEX IF EXISTS idx_medical_date;
    DROP INDEX IF EXISTS idx_meddoc_uploaded;
    DROP INDEX IF EXISTS idx_activities_external;
    DROP INDEX IF EXISTS idx_medical_external;

    CREATE INDEX IF NOT EXISTS idx_activities_profile_date ON activities(profile_id, date);
    CREATE INDEX IF NOT EXISTS idx_body_metrics_profile_date ON body_metrics(profile_id, date);
    CREATE INDEX IF NOT EXISTS idx_immunizations_profile ON immunizations(profile_id, vaccine, date);
    CREATE INDEX IF NOT EXISTS idx_medical_profile_date ON medical_records(profile_id, date);
    CREATE INDEX IF NOT EXISTS idx_meddoc_profile_uploaded ON medical_documents(profile_id, uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_metric_samples_md ON metric_samples(profile_id, metric, date);
    CREATE INDEX IF NOT EXISTS idx_hr_minutes_day ON hr_minutes(profile_id, substr(ts,1,10));

    CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_external
      ON activities(profile_id, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medical_external
      ON medical_records(profile_id, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_immunizations_external
      ON immunizations(profile_id, external_id) WHERE external_id IS NOT NULL;
  `);
}
