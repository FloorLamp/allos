import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 031 (issue #580): grow frequency_targets.scope_kind to admit a
// 'food_group' scope, so "fatty fish ≥2×/week" is a first-class weekly target on the
// SAME table (and the same protocol frequency_target_id link, ownership, and cleanup)
// the training routine targets already use — the "compose, don't fork" call from the
// nutrition umbrella (#576). The food-group progress is the #579 weekly rollup (one
// question, one computation), branched into getFrequencyTargetProgress.
//
// SQLite can't ALTER a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 006/011/015/016/018).
// frequency_targets is a FK PARENT (protocols.frequency_target_id REFERENCES it, from
// migration 025); the runner applies every migration with foreign_keys OFF and
// restores it after, so dropping and recreating the table does NOT cascade-wipe the
// referencing protocols, and ids are preserved in the copy so every existing
// frequency_target_id link stays valid. No secondary indexes.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK listing 'food_group'); a second run is a pure no-op.
//
// The scratch table ends in `_new` so the profile-scoping owned-table scanner
// (lib/__tests__/profile-scoping.test.ts) skips the transient (frequency_targets
// DECLARES profile_id). Determinism: reads only the DB + its own constants.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "frequency_targets");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (sql.includes("'food_group'")) return; // already converged (CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE frequency_targets__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind TEXT NOT NULL CHECK (
          scope_kind IN ('region','group','type','food_group')
        ),
        scope_value TEXT NOT NULL,
        per_week INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        profile_id INTEGER NOT NULL REFERENCES profiles(id)
      );
      INSERT INTO frequency_targets__new
        (id, scope_kind, scope_value, per_week, created_at, profile_id)
        SELECT id, scope_kind, scope_value, per_week, created_at, profile_id
          FROM frequency_targets;
      DROP TABLE frequency_targets;
      ALTER TABLE frequency_targets__new RENAME TO frequency_targets;
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 31,
  name: "031-frequency-target-food-group",
  up,
};
