import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 053 (issue #824): the protein-grams quick-add log — the direct-grams
// `logged` basis #767 reserved. Protein powder / shakes have no representation in the
// whole-foods food-group catalog (deliberately — a `protein_shake` group would double-
// count once someone also logs the milk/eggs in it), so a shake's grams need their OWN
// home. This is it: a single running gram total per day, SUMMED with the food-group
// `estimated` floor (never replacing it) and OVERRIDDEN by an integration's measured
// `tracked` protein_g — see lib/protein.ts proteinIntake().
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`
// so it joins OWNED_TABLES (lib/owned-tables.ts) — that single edit propagates to
// deleteProfile and the profile-scoping leak test. UNIQUE(profile_id, date) so a day's
// manually-logged grams are ONE row whose `grams` the quick-add bumps up (add) or down
// (undo); the keyed upsert (ON CONFLICT) makes an add idempotent-friendly per day, and
// the row is dropped once it returns to zero (no stray zero rows — the food_log
// discipline). Grams is REAL and CHECK (grams >= 0) so an undo can't drive it negative.
//
// CREATE ... IF NOT EXISTS + the index guard keep the non-version-gated migrate() replay
// a no-op. Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS protein_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date       TEXT NOT NULL,
      grams      REAL NOT NULL DEFAULT 0 CHECK (grams >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (profile_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_protein_log_profile
      ON protein_log(profile_id, date DESC);
  `);
}

export const migration: Migration = {
  id: 53,
  name: "053-protein-log",
  up,
};
