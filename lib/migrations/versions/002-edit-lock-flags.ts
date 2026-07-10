import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 002 (issue #133): protect hand-edited IMPORTED body metrics & vitals
// from the rolling-window re-ingest.
//
// Health Connect (and any future push provider) re-pushes a rolling 48h window and
// upserts it every sync. Activities already carry an `edited` user-edit lock: once a
// user hand-edits an imported activity, the ingest sees `edited` and leaves the row
// alone. That protection existed ONLY for activities — an imported body-metric or
// vital the user corrected was silently reverted on the next sync. This migration
// extends the same lock to the two tables the ingest also owns:
//
//   • body_metrics.edited   — consulted by upsertBodyMetrics (mergeBodyMetric path)
//   • medical_records.edited — consulted by upsertVitals (external_id match path)
//
// It also closes the related gap the issue calls out: body_metrics had NO DB
// uniqueness on its (profile_id, date, source) dedup key — it was enforced only by an
// app-level SELECT-then-write, unlike metric_samples / hr_minutes / activities which
// are all DB-keyed. Adding UNIQUE(profile_id, date, source) lets the upsert use
// `ON CONFLICT DO UPDATE` (atomic, race-safe) instead of the hand-rolled read-modify.
// A NULL `source` (manual / document-projected rows) is exempt — SQLite treats NULLs
// as distinct in a unique index — which is exactly right: only integration-sourced
// rows flow through the keyed upsert, and two manual weigh-ins on one day stay legal.
//
// Idempotent by construction (guarded ADD COLUMN, a no-op-on-clean DELETE, and
// CREATE UNIQUE INDEX IF NOT EXISTS) so the non-version-gated `migrate()` test
// wrapper can replay it without throwing; production runs it exactly once (version
// gate). Determinism rule (spec): reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  // ── 1. The user-edit lock columns (mirrors activities.edited) ──────────────
  // Guarded so a replay of the whole migration list (the migrate() test wrapper)
  // doesn't hit "duplicate column name".
  if (!columnNames(db, "body_metrics").has("edited")) {
    db.exec(
      `ALTER TABLE body_metrics ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;`
    );
  }
  if (!columnNames(db, "medical_records").has("edited")) {
    db.exec(
      `ALTER TABLE medical_records ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;`
    );
  }

  // ── 2. Collapse any pre-existing (profile_id, date, source) collisions ─────
  // The app-level SELECT-then-write already enforced this key, so this is
  // defensive — but a duplicate would make the new UNIQUE index un-creatable. Keep
  // the LOWEST id per key (the row the upsert's `ORDER BY id LIMIT 1` find would
  // have matched). NULL source is EXCLUDED from both the group and the delete so
  // legitimate manual/document rows sharing a (profile, date) are never removed.
  db.exec(
    `DELETE FROM body_metrics
       WHERE source IS NOT NULL
         AND id NOT IN (
           SELECT MIN(id) FROM body_metrics
             WHERE source IS NOT NULL
             GROUP BY profile_id, date, source
         );`
  );

  // ── 3. The uniqueness the ingest upsert can now key ON CONFLICT against ────
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_body_metrics_source
       ON body_metrics(profile_id, date, source);`
  );
}

export const migration: Migration = {
  id: 2,
  name: "002-edit-lock-flags",
  up,
};
