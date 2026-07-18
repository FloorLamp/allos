import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 059 (issue #840): grow frequency_targets.scope_kind to admit a
// 'mobility_region' scope, so "hips 3×/week" is a first-class weekly HABIT target on the
// SAME table the training/food targets use (pace tones, the dashboard Goals-and-habits
// card, and weekly-recap accounting come free). Its scope_value is a MuscleRegion, but
// its progress counts RECOVERY-session mobilized days — a SEPARATE view from the `region`
// scope's trained days (#482: trained ≠ mobilized), which is exactly why it is its own
// scope_kind rather than reusing `region`.
//
// SQLite can't ALTER a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 006/011/015/016/018/031).
// frequency_targets is a FK PARENT (protocols.frequency_target_id REFERENCES it, from
// migration 025); the runner applies every migration with foreign_keys OFF and restores
// it after, so dropping and recreating the table does NOT cascade-wipe the referencing
// protocols, and ids are preserved in the copy so every existing frequency_target_id link
// stays valid. UNLIKE migration 031's rebuild, this one runs AFTER migration 038 added a
// PARTIAL UNIQUE INDEX (food_group dedup), so the rebuild MUST recreate that index — a
// dropped-and-not-recreated index would silently re-open the #748-item-4 double-track race
// and diverge the schema from a fresh build (the migrate() no-op replay test catches it).
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK listing 'mobility_region'); a second run is a pure no-op.
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
  if (sql.includes("'mobility_region'")) return; // already converged (CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE frequency_targets__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind TEXT NOT NULL CHECK (
          scope_kind IN ('region','group','type','food_group','mobility_region')
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_frequency_targets_food_group_unique
        ON frequency_targets(profile_id, scope_value)
        WHERE scope_kind = 'food_group';
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 59,
  name: "059-frequency-target-mobility-region",
  up,
};
