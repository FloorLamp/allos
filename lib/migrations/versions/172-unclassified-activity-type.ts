import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 172 (issue #2272): grow the activities.type CHECK to admit an
// 'unclassified' type — THE SOURCE DID NOT SAY. Health Connect's
// EXERCISE_TYPE_OTHER_WORKOUT means "a workout, unspecified"; the parser answered that
// stated absence with `sport`, so the row asserted a classification no provider ever
// made and nothing downstream could tell an asserted type from a guessed one.
// `unclassified` is reachable only by IMPORT — the activity form's input union stays
// three-valued, because a human at a form always has an answer.
//
// SQLite can't ALTER a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename, following migration 058 (which added
// 'recovery' for issue #840) exactly. `activities` is a heavily-referenced FK PARENT
// (exercise_sets, activity_routes, activity_laps, fitness_assessments and others
// REFERENCE activities(id)); the runner applies every migration with foreign_keys OFF
// and restores it after, so dropping and recreating the table does NOT cascade-wipe the
// referencing children, and ids are preserved in the copy so every existing
// activity_id link stays valid. The two secondary indexes are recreated.
//
// NO BACKFILL. Existing `sport` rows are left exactly as they are. An already-stored
// `sport` may be a correct call the user has since relied on, and a rule change does
// not earn the right to rewrite history — the honest fix is what NEW imports claim.
//
// The scratch column list is the CURRENT full schema: 058's list PLUS `elapsed_min`
// (the additive ALTER from migration 106). A drift here would silently drop a column,
// so it is pinned by the fresh-build no-op replay test.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK listing 'unclassified'); a second run is a pure no-op.
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
  if (sql.includes("'unclassified'")) return; // already converged (CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE activities__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        date TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('strength','cardio','sport','recovery','unclassified')),
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
        equipment_id INTEGER REFERENCES equipment(id),
        elapsed_min INTEGER
      );
      INSERT INTO activities__new
        SELECT
          id, profile_id, date, type, title, notes, duration_min, distance_km,
          intensity, start_time, end_time, components, created_at, source, external_id,
          avg_hr, max_hr, elevation_m, avg_speed_kmh, max_speed_kmh, relative_effort,
          avg_power_w, max_power_w, weighted_avg_power_w, avg_cadence, avg_temp_c,
          kilojoules, workout_type, edited, updated_at, est_calories, equipment_id,
          elapsed_min
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
  id: 172,
  name: "172-unclassified-activity-type",
  up,
};
