import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 015 (issue #323): grow the import_jobs.status CHECK enum to admit the
// transient in-flight 'committing' state.
//
// commitImportJob claims a ready job atomically by flipping 'ready' → 'committing'
// (app/(app)/data/actions.ts), so a double-click can't import the same rows twice.
// But the baseline CHECK only allowed ('processing','ready','failed','skipped'), so
// that UPDATE threw `CHECK constraint failed` on EVERY save — the feature was fully
// broken. The TS union and jobLogStatus already knew 'committing'; only the schema
// forbade it. This adds it to the enum so the claim can land.
//
// SQLite cannot alter a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 006/011). import_jobs
// is not a FK parent (nothing references it) and its only FK is → profiles(id), so
// the drop cascades nothing; the runner and the migrate() test wrapper both apply
// with foreign_keys OFF regardless. The idx_import_jobs_created index is recreated.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema
// (the CHECK already listing 'committing'); a second run is a pure no-op. Production
// runs it exactly once behind the user_version gate. Determinism rule (spec): reads
// only the DB + its own constants.
//
// The scratch table is named `import_jobs__new` (ending in `_new`) on purpose:
// unlike the earlier rebuild scratch tables, import_jobs DECLARES profile_id, so the
// profile-scoping owned-table scanner (lib/__tests__/profile-scoping.test.ts) would
// otherwise mistake the transient scratch for a new profile-owned table. That scanner
// skips names ending in `_new`.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "import_jobs");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (sql.includes("'committing'")) return; // already converged

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE import_jobs__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        type TEXT NOT NULL CHECK (type IN ('workouts','biomarkers')),
        status TEXT NOT NULL DEFAULT 'processing'
          CHECK (status IN ('processing','ready','committing','failed','skipped')),
        source_text TEXT,
        result_json TEXT,
        summary TEXT,
        error TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO import_jobs__new
        (id, profile_id, type, status, source_text, result_json, summary, error,
         model, created_at, updated_at)
        SELECT id, profile_id, type, status, source_text, result_json, summary,
               error, model, created_at, updated_at
          FROM import_jobs;
      DROP TABLE import_jobs;
      ALTER TABLE import_jobs__new RENAME TO import_jobs;
      CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON import_jobs(created_at);
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 15,
  name: "015-import-job-committing-state",
  up,
};
