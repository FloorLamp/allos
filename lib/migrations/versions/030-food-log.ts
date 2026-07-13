import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 030 (issue #579): the food-group serving log — the INPUT half of the
// nutrition umbrella (#576). A curated set of ~20–30 food groups (fatty fish, leafy
// greens, legumes, …) logged as SERVINGS, one tap each, instead of full macro tracking
// (the habit tier, deliberately — see docs/nutrition-feasibility.md). The evidence for
// dietary guidance is food-group-shaped ("2 servings of fatty fish a week"), which is
// exactly what the output engine (#577) and the food-habit targets (#580) consume.
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`
// so it joins OWNED_TABLES (lib/owned-tables.ts) — that single edit propagates to
// deleteProfile and the profile-scoping leak test. UNIQUE(profile_id, date, group_key)
// so a day's tally for a group is ONE row whose `servings` count the one-tap bar
// increments (undo = decrement); the keyed upsert (ON CONFLICT) makes logging
// idempotent per (day, group). `group_key` is a STABLE slug from lib/food-groups.json
// (the #203 discipline: treat any rename as display-only, never re-slug).
//
// CREATE ... IF NOT EXISTS + the index guard keep the non-version-gated migrate()
// replay a no-op. Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS food_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date       TEXT NOT NULL,
      group_key  TEXT NOT NULL,
      servings   REAL NOT NULL DEFAULT 0 CHECK (servings >= 0),
      notes      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, date, group_key)
    );
    CREATE INDEX IF NOT EXISTS idx_food_log_profile
      ON food_log(profile_id, date DESC);
  `);
}

export const migration: Migration = {
  id: 30,
  name: "030-food-log",
  up,
};
