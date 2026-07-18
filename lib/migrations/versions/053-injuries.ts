import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 053 (issue #838): the injury layer — user-declared region constraints on
// training. An `injuries` row is the USER'S explicit "this region is off the table"
// instruction (the equipment-availability class of #666's context taxonomy, NOT the
// medical-judgment class), so the recommendation engine may exclude its regions — always
// DISCLOSED on the card, never silent.
//
//   • `injuries` is directly profile-OWNED — born `profile_id INTEGER NOT NULL
//     REFERENCES profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts) and is
//     cleared by profile_id on profile deletion.
//   • `regions` is a JSON MuscleRegion[] (the coarse 7-value vocabulary the engine
//     excludes on); `muscles` is an OPTIONAL JSON MuscleId[] (the finer #735 vocabulary),
//     null when the user only picked regions. Nothing FKs into this table.
//   • `status` is active / recovering / resolved: active ⇒ regions excluded; recovering ⇒
//     tempered targets (a suggestion, never a lockout); resolved ⇒ normal, record kept.
//
// CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated migrate() replay
// a pure no-op. Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS injuries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      label         TEXT NOT NULL,
      regions       TEXT NOT NULL,
      muscles       TEXT,
      status        TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','recovering','resolved')),
      since         TEXT,
      resolved_date TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_injuries_profile
      ON injuries(profile_id, status);
  `);
}

export const migration: Migration = {
  id: 53,
  name: "053-injuries",
  up,
};
