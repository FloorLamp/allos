import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 057 (issue #839): endurance event plans — training TOWARD a race/event.
// An `endurance_plans` row is the USER'S goal: an event on a date, a discipline
// (run/ride/swim — the cardio disciplines the classifier knows), a target distance
// (km, canonical), an optional target time (seconds), and a status. The pure
// trajectory engine (lib/endurance-plan.ts) derives the weekly volume/long-session
// targets from (event date, target distance, CURRENT logged weekly volume) — the
// row stores only the goal, never the derived plan (recomputed from actuals so a
// missed week auto-adjusts; no debt accounting).
//
//   • `endurance_plans` is directly profile-OWNED — born `profile_id INTEGER NOT
//     NULL REFERENCES profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts)
//     and is cleared by profile_id on profile deletion. Nothing FKs into it.
//   • ONE active plan per discipline (same one-per-scope shape as food-habit
//     targets): a partial UNIQUE index over (profile_id, discipline) WHERE
//     status = 'active' enforces it in the DB, and the create/edit cores refuse a
//     second active plan for the same discipline with a friendly error.
//   • `discipline` ∈ run/ride/swim; `status` ∈ active/completed/abandoned.
//   • `target_time_sec` is optional (a pure goal annotation — v1 prescribes volume
//     + long session only, never pace). `session_kinds` is a reserved JSON slot for
//     the future structured-interval arm (#839 non-goal) — null in v1.
//
// CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated migrate()
// replay a pure no-op. Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS endurance_plans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id      INTEGER NOT NULL REFERENCES profiles(id),
      event_name      TEXT,
      discipline      TEXT NOT NULL
                        CHECK (discipline IN ('run','ride','swim')),
      event_date      TEXT NOT NULL,
      target_distance_km REAL NOT NULL,
      target_time_sec INTEGER,
      status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','completed','abandoned')),
      session_kinds   TEXT,
      notes           TEXT,
      completed_on    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_endurance_plans_profile
      ON endurance_plans(profile_id, status);
    -- ONE active plan per discipline (partial unique: only 'active' rows collide,
    -- so a profile may keep many completed/abandoned plans for the same discipline).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_endurance_plans_active_discipline
      ON endurance_plans(profile_id, discipline)
      WHERE status = 'active';
  `);
}

export const migration: Migration = {
  id: 57,
  name: "057-endurance-plans",
  up,
};
