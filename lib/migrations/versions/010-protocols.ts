import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 010 (issue #161): the N-of-1 `protocols` table. A protocol is a dated
// self-experiment (creatine, a sauna block, Zone 2 emphasis, TRE) with a declared
// set of OUTCOME METRICS the app compares before vs. during. It is profile-OWNED —
// born `profile_id INTEGER NOT NULL REFERENCES profiles(id)` — so every read
// filters profile_id (the profile-scoping test) and deleteProfile clears it by
// profile_id; it is registered in lib/owned-tables.ts.
//
// The outcome-metric SET is stored as a JSON array in `outcome_keys` (namespaced
// keys like "biomarker:LDL Cholesterol" / "metric:resting_hr" / "index:phenoage").
// A JSON column matches the codebase's precedent for a small opaque string set
// owned by one row (dashboard_layout / trend_pins / active_situations) and avoids
// a child table whose every read would need a JOIN back to protocols to stay
// profile-scoped. `situation` is the optional situational-intake label a protocol
// activates on start (reusing the existing situations wiring); no FK — situations
// are a free-text profile_settings concept, not a table.
//
// Replay-safe by construction (CREATE ... IF NOT EXISTS): the non-version-gated
// migrate() test wrapper replays every migration, while production applies it once
// behind the user_version gate. Deterministic — reads/writes only the DB.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS protocols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      notes TEXT,
      outcome_keys TEXT NOT NULL DEFAULT '[]',
      situation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_protocols_profile
      ON protocols(profile_id, start_date DESC);
  `);
}

export const migration: Migration = {
  id: 10,
  name: "010-protocols",
  up,
};
