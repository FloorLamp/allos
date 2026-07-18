import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 056 (issue #840, folding in #344): grow the activities.type CHECK to admit
// a 'recovery' type — the HABIT-tier mobility/flexibility session (one activity row
// whose `components` are the tapped moves). A mobility session rides the existing
// timeline/journal/streaks/heatmap for free by being an ordinary activities row of a new
// type; no parallel table.
//
// SQLite can't ALTER a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 006/011/015/016/018/031).
// `activities` is a heavily-referenced FK PARENT (exercise_sets, activity_routes,
// fitness_assessments all REFERENCE activities(id)); the runner applies every migration
// with foreign_keys OFF and restores it after, so dropping and recreating the table does
// NOT cascade-wipe the referencing children, and ids are preserved in the copy so every
// existing activity_id link stays valid. The two secondary indexes are recreated.
//
// The scratch column list is the CURRENT full schema — the baseline columns PLUS the two
// added by additive ALTERs (est_calories, migration 009; equipment_id, migration 019) —
// so the rebuilt table is byte-identical apart from the widened CHECK. A drift here would
// silently drop a column, so it is pinned by the fresh-build no-op replay test.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK listing 'recovery'); a second run is a pure no-op.
//
// The scratch table ends in `_new` so the profile-scoping owned-table scanner
// (lib/__tests__/profile-scoping.test.ts) skips the transient (activities DECLARES
// profile_id). Determinism: reads only the DB + its own constants.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "activities");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (sql.includes("'recovery'")) return; // already converged (CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE activities__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('strength','cardio','sport','recovery')),
        title TEXT NOT NULL,
        notes TEXT,
        duration_min INTEGER,
        distance_km REAL,
        intensity TEXT,
        start_time TEXT,
        end_time TEXT,
        components TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT,
        external_id TEXT,
        avg_hr REAL,
        max_hr REAL,
        elevation_m REAL,
        avg_speed_kmh REAL,
        max_speed_kmh REAL,
        relative_effort REAL,
        avg_power_w REAL,
        max_power_w REAL,
        weighted_avg_power_w REAL,
        avg_cadence REAL,
        avg_temp_c REAL,
        kilojoules REAL,
        workout_type TEXT,
        edited INTEGER DEFAULT 0,
        updated_at TEXT,
        est_calories REAL,
        equipment_id INTEGER REFERENCES equipment(id)
      );
      INSERT INTO activities__new
        SELECT
          id, profile_id, date, type, title, notes, duration_min, distance_km,
          intensity, start_time, end_time, components, created_at, source, external_id,
          avg_hr, max_hr, elevation_m, avg_speed_kmh, max_speed_kmh, relative_effort,
          avg_power_w, max_power_w, weighted_avg_power_w, avg_cadence, avg_temp_c,
          kilojoules, workout_type, edited, updated_at, est_calories, equipment_id
        FROM activities;
      DROP TABLE activities;
      ALTER TABLE activities__new RENAME TO activities;
      CREATE INDEX IF NOT EXISTS idx_activities_profile_date
        ON activities(profile_id, date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_external
        ON activities(profile_id, external_id) WHERE external_id IS NOT NULL;
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 56,
  name: "056-recovery-activity-type",
  up,
};
