import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 055 (issue #834): the guided "Fitness check" test-battery session model.
//
// A fitness check is a curated battery of tests the user performs and inputs in one
// dated SESSION. The measured VALUES land in their natural stores — timed/rep tests as
// `exercise_sets` on an assessment `activities` row (so exerciseHistoryKey + every
// training surface sees them), body composition in `body_metrics`, and VO2/grip/etc. as
// vitals-input `medical_records` (the canonical names the fitness-norms engine reads).
// This migration adds the two tables that GROUP those entries into a session and record
// its COVERAGE — never a parallel value system.
//
// fitness_assessments — one PROFILE-OWNED session row per (profile, date). Born
// `profile_id INTEGER NOT NULL REFERENCES profiles(id)` so it joins OWNED_TABLES
// (lib/owned-tables.ts); that single edit propagates to deleteProfile + the
// profile-scoping leak test. `activity_id` links the assessment activity that holds the
// set-based tests; it is `ON DELETE SET NULL` so a user deleting that activity (or
// deleteProfile clearing `activities` before this table) nulls the link rather than
// throwing an FK error — the session row survives, its set-based coverage simply
// unlinks. UNIQUE(profile_id, date) makes a day ONE session (a second entry that day
// joins the same session).
//
// fitness_assessment_entries — one CHILD row per test measured in a session (no
// profile_id; scoped/deleted THROUGH its parent via the CASCADE FK, exactly like
// exercise_sets → activities). It is the session's COVERAGE LEDGER: which test, which
// tier, which natural store it wrote to, plus a canonical `value` SNAPSHOT (for
// completion % + check-over-check deltas without a fan-out join) and the raw field-test
// input JSON (Cooper distance, walk time+HR) the VO2 calculators derived the value from.
// The snapshot is the session's own record — the AUTHORITATIVE row lives in the natural
// store, which independently feeds every OTHER surface (healthspan pillars, fitness age,
// biomarker series). UNIQUE(assessment_id, test_key) makes a re-entry of a test UPDATE
// its entry in place rather than duplicate.
//
// CREATE ... IF NOT EXISTS keeps the non-version-gated migrate() replay a pure no-op.
// Determinism: reads only its own DDL constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fitness_assessments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id),
      date        TEXT NOT NULL,
      activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_fitness_assessments_profile
      ON fitness_assessments(profile_id, date DESC);

    CREATE TABLE IF NOT EXISTS fitness_assessment_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES fitness_assessments(id) ON DELETE CASCADE,
      test_key      TEXT NOT NULL,
      tier          TEXT NOT NULL,
      store         TEXT NOT NULL CHECK (store IN ('set', 'vital', 'body')),
      value         REAL NOT NULL,
      unit          TEXT NOT NULL,
      raw_input     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (assessment_id, test_key)
    );
    CREATE INDEX IF NOT EXISTS idx_fitness_assessment_entries_assessment
      ON fitness_assessment_entries(assessment_id);
  `);
}

export const migration: Migration = {
  id: 55,
  name: "055-fitness-assessments",
  up,
};
