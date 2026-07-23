import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 098 (issue #1259): wellness practices as protocol adherence. Two
// coordinated schema changes that ship as ONE version (a CHECK-rebuild and a new
// table can share a migration):
//
//   1. frequency_targets gains a 'practice' scope_kind and a nullable per_week_max.
//      • scope_kind now admits 'practice' — a named wellness modality (red light,
//        sauna, cold plunge, meditation, breathwork, …) whose scope_value is the
//        practice name (free text; curated starter list in lib/practice.ts). It
//        joins getFrequencyTargetProgress with NORMAL floor semantics (counted from
//        practice_logs below), unlike the inverted 'substance' cap.
//      • per_week_max makes per_week a RANGE: per_week is the floor (drives adherence
//        + nudges), per_week_max the OPTIONAL ceiling ("3–5×/week" → floor 3, max 5).
//        At/above the ceiling the surfaces render a calm "that's plenty this week" and
//        the nudge goes quiet — never a red state. NULL leaves an existing single-floor
//        target unchanged. Applies to every scope (the column is general), but the
//        picker only offers it for practices.
//
//      SQLite can't ALTER a CHECK in place, so this is the documented rebuild
//      (create-scratch → copy → drop → rename), matching migrations 031/059/072.
//      frequency_targets is a FK PARENT (protocols.frequency_target_id, migration
//      025); the runner applies migrations with foreign_keys OFF and restores it
//      after, so the drop/recreate doesn't cascade-wipe referencing protocols, and
//      ids are preserved in the copy so every frequency_target_id link stays valid.
//      Like 059/072 the rebuild MUST recreate the 038 food_group partial UNIQUE index
//      and the 072 substance partial UNIQUE index. per_week_max copies as NULL for
//      existing rows (the column is new).
//
//   2. practice_logs — a minimal dedicated per-session store. A DELIBERATE, documented
//      exception to the reuse-a-store rule (#860/#944): a practice session is not an
//      observation with a value, and nearly every `activities` column (sets,
//      components, intensity, calories, equipment, the source/edited import machinery)
//      is inapplicable dead weight for it. Manual-only (no importer), so the
//      observation-substrate ingest obligations (edit lock, dedup split, latest-per-
//      group) don't attach. One (practice, date) TICK with OPTIONAL time-of-day
//      (`time`, local HH:MM in the profile's timezone) and `duration_min` (canonical
//      minutes). MULTI-SESSION days are supported from the start (the PRN
//      administration-ledger model, #797: one row per real session, NO day-level
//      UNIQUE) — adherence stays day-distinct (COUNT(DISTINCT date)) regardless.
//
//      One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES
//      profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts) — that single edit
//      propagates to deleteProfile and the profile-scoping leak test — and the
//      portable-export DATASETS (export-completeness binds them). Timeline surfaces it
//      via its own entry in lib/timeline.ts. CREATE ... IF NOT EXISTS + the index
//      guards keep the non-version-gated migrate() replay a no-op.
//
// The scratch table ends in `_new` so the profile-scoping owned-table scanner skips
// the transient. Determinism: reads only the DB + its own constants.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    // ---- Part 1: frequency_targets — 'practice' scope + per_week_max ----------
    const sql = tableSql(db, "frequency_targets");
    if (sql !== null && !sql.includes("'practice'")) {
      db.exec(`
        CREATE TABLE frequency_targets__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_kind TEXT NOT NULL CHECK (
            scope_kind IN ('region','group','type','food_group','mobility_region','substance','practice')
          ),
          scope_value TEXT NOT NULL,
          per_week INTEGER NOT NULL,
          per_week_max INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          profile_id INTEGER NOT NULL REFERENCES profiles(id)
        );
        INSERT INTO frequency_targets__new
          (id, scope_kind, scope_value, per_week, per_week_max, created_at, profile_id)
          SELECT id, scope_kind, scope_value, per_week, NULL, created_at, profile_id
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
    }

    // ---- Part 2: practice_logs — the minimal per-session store ----------------
    db.exec(`
      CREATE TABLE IF NOT EXISTS practice_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        practice TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT,
        duration_min INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_practice_logs_profile_date
        ON practice_logs(profile_id, date);
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 98,
  name: "098-practice-targets-and-logs",
  up,
};
