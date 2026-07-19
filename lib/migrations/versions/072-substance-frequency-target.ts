import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 072 (issue #998): grow frequency_targets.scope_kind to admit a
// 'substance' scope, so a reduction/cessation target ("≤ 7 standard drinks/week",
// cap 0 = an alcohol-free week) is a first-class row on the SAME table the
// training/food/mobility habit targets use — the existing frequency_targets
// machinery, not a parallel engine. scope_value is a lib/substance-use.ts
// Substance key ('alcohol'); per_week is a weekly CAP (a ceiling, ≥ 0), the
// INVERSE of every other scope's floor — which is why substance rows are
// deliberately EXCLUDED from getFrequencyTargetProgress (a floor-semantics
// reader would nag toward MORE consumption) and read instead through
// lib/queries/substance.ts.
//
// SQLite can't ALTER a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 031/059).
// frequency_targets is a FK PARENT (protocols.frequency_target_id, migration
// 025); the runner applies migrations with foreign_keys OFF and restores it
// after, so the drop/recreate does not cascade-wipe referencing protocols, and
// ids are preserved in the copy so every existing frequency_target_id link stays
// valid. Like 059, the rebuild MUST recreate the 038 food_group partial UNIQUE
// index — and it adds the matching 'substance' partial UNIQUE index (one target
// per substance per profile) that the upsert's ON CONFLICT targets.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an
// already-converged DB, so the rebuild is guarded by a sentinel read off the live
// schema (the CHECK listing 'substance'); a second run is a pure no-op — except
// the index guard, which is IF NOT EXISTS anyway.
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
  if (sql.includes("'substance'")) return; // already converged (CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE frequency_targets__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind TEXT NOT NULL CHECK (
          scope_kind IN ('region','group','type','food_group','mobility_region','substance')
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_frequency_targets_substance_unique
        ON frequency_targets(profile_id, scope_value)
        WHERE scope_kind = 'substance';
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 72,
  name: "072-substance-frequency-target",
  up,
};
