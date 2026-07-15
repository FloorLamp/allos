import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 039 (issue #738, Pillar 3 of the workout-UX epic #732): the three
// tables behind adopted/authored training routines. A routine is a declarative,
// user-owned program (#559: the engine resolves and fills it, it NEVER invents
// one). Templates and custom routines share ONE runtime representation — adopting
// a template COPIES it into these tables, after which it is indistinguishable from
// a hand-authored routine, so the engine (#740) only ever reads this DB shape.
//
//   • `routines` is directly profile-OWNED — born `profile_id INTEGER NOT NULL
//     REFERENCES profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts) and
//     is cleared by profile_id on profile deletion.
//   • `routine_days` and `routine_slots` are CHILD tables (no profile_id of their
//     own): they reach profile_id via a JOIN to routines (routine_days.routine_id
//     → routines.id, routine_slots.routine_day_id → routine_days.id), exactly like
//     exercise_sets reaches it through activities. They are therefore intentionally
//     ABSENT from OWNED_TABLES and are deleted through their parent in deleteProfile
//     (and in the routine-delete write core).
//
// Tables are created parent-first (routines → routine_days → routine_slots) so the
// REFERENCES targets exist when each child is created; deleteProfile toggles
// foreign_keys OFF for its sweep, but correct ordering is belt-and-suspenders.
//
// `cycle_weeks` ships here but is INERT until #741 adds mesocycle/deload behavior.
// `focus` is a JSON MuscleRegion[]; `candidates` is a JSON string[] of ordered
// exercise names (first the user can actually do wins, filled at recommendation
// time in #740). CREATE ... IF NOT EXISTS + the index guards keep the
// non-version-gated migrate() replay a pure no-op. Determinism (spec): reads only
// the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      source       TEXT NOT NULL CHECK (source IN ('template','custom')),
      template_id  TEXT,
      active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      started_date TEXT,
      position     INTEGER NOT NULL DEFAULT 0,
      cycle_weeks  INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      profile_id   INTEGER NOT NULL REFERENCES profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_routines_profile
      ON routines(profile_id);
    CREATE INDEX IF NOT EXISTS idx_routines_active
      ON routines(profile_id, active);

    CREATE TABLE IF NOT EXISTS routine_days (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id INTEGER NOT NULL REFERENCES routines(id),
      ordinal    INTEGER NOT NULL,
      label      TEXT NOT NULL,
      focus      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_days_routine
      ON routine_days(routine_id, ordinal);

    CREATE TABLE IF NOT EXISTS routine_slots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_day_id INTEGER NOT NULL REFERENCES routine_days(id),
      ordinal        INTEGER NOT NULL,
      candidates     TEXT NOT NULL,
      sets           INTEGER NOT NULL,
      rep_min        INTEGER NOT NULL,
      rep_max        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_slots_day
      ON routine_slots(routine_day_id, ordinal);
  `);
}

export const migration: Migration = {
  id: 39,
  name: "039-routines",
  up,
};
