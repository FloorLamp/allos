import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 016 (issue #328, part 1): shrink the goals.status CHECK enum to drop
// the never-written 'archived' state, so the state set has one representation.
//
// A goal's lifecycle status is ('active' | 'achieved') — that is the TS GoalStatus
// union AND every writer (goals/actions.ts setStatus only ever writes 'active' or
// 'achieved'). "Archived" is an INDEPENDENT boolean column (goals.archived), toggled
// by setArchived, so an achieved goal stays achieved when filed away. The baseline
// CHECK also admitted a status value 'archived' that NO writer produces and NO reader
// distinguishes (all four surfaces use `status === 'active' && !archived`) — a dead
// third representation of one lifecycle. This drops it: the boolean is now the single
// archived representation, and the CHECK matches GoalStatus exactly.
//
// SQLite cannot alter a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 006/011/015). goals is
// not a FK parent (nothing references goals(id)) and has no indexes to recreate; its
// only FK is → profiles(id), so the drop cascades nothing. The runner and the
// migrate() test wrapper both apply with foreign_keys OFF regardless.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK still listing the quoted literal 'archived'); a second run is a pure no-op.
// The sentinel matches the quoted CHECK literal `'archived'`, NOT the `archived`
// column name (which is bare, unquoted), so a converged table reads false. Production
// runs it exactly once behind the user_version gate. Determinism rule (spec): reads
// only the DB + its own constants.
//
// The scratch table is named `goals__new` (ending in `_new`) on purpose: goals
// DECLARES profile_id, so the profile-scoping owned-table scanner
// (lib/__tests__/profile-scoping.test.ts) would otherwise mistake the transient
// scratch for a new profile-owned table. That scanner skips names ending in `_new`.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "goals");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (!sql.includes("'archived'")) return; // already converged (CHECK dropped it)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE goals__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        title TEXT NOT NULL,
        description TEXT,
        category TEXT,
        target_value REAL,
        current_value REAL,
        unit TEXT,
        target_date TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        exercise TEXT,
        metric TEXT,
        target_weight_kg REAL,
        target_reps INTEGER,
        target_sets INTEGER,
        target_duration_sec INTEGER,
        body_metric TEXT,
        baseline_value REAL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO goals__new
        (id, profile_id, title, description, category, target_value, current_value,
         unit, target_date, status, created_at, exercise, metric, target_weight_kg,
         target_reps, target_sets, target_duration_sec, body_metric, baseline_value,
         archived)
        SELECT id, profile_id, title, description, category, target_value,
               current_value, unit, target_date,
               -- fold any legacy status='archived' row into (status='active',
               -- archived=1) so the tighter CHECK admits every copied row.
               CASE WHEN status = 'archived' THEN 'active' ELSE status END,
               created_at, exercise, metric, target_weight_kg, target_reps,
               target_sets, target_duration_sec, body_metric, baseline_value,
               CASE WHEN status = 'archived' THEN 1 ELSE archived END
          FROM goals;
      DROP TABLE goals;
      ALTER TABLE goals__new RENAME TO goals;
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 16,
  name: "016-goal-status-drop-archived",
  up,
};
