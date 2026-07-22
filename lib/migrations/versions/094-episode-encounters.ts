import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 094 (issue #1198): promote illness episode ↔ visit from a single nullable
// FK (`illness_episodes.encounter_id`, migration 082) to a real MANY relationship via a
// dedicated `episode_encounters` link table. A real illness spans several encounters
// (PCP → urgent care → specialist → follow-up); the 1:1 column forced picking one and
// silently dropped the rest on relink.
//
// MODEL DECISION (issue's open question): DROP the FK column, do NOT keep a
// `primary_encounter_id`. Nothing consumes `illness_episodes.encounter_id` as a
// "primary" today — its only reader is the cockpit Care line, which becomes a
// date-ordered LIST. A retained primary FK would reintroduce exactly the two-sources-
// disagree hazard (#203) this issue closes: the link set and a primary column could
// drift on relink/unlink. "First visit by date" is a trivial pure selector over the
// ordered set for any future compact surface, so a stored primary buys only drift risk.
//
// House rules: NEW profile-OWNED table (born `profile_id INTEGER NOT NULL`), so it joins
// OWNED_TABLES. NOT an import-footprint table (written by the link/unlink actions, not a
// document import — the visit_link_decisions posture). The link's `encounter_id` FK
// carries NO ON DELETE — deleting an encounter deletes its link rows first
// (nullEncounterLinks, the row-ops convention). Each column of the link carries a real
// REFERENCES FK (the #95 convergence). CREATE ... IF NOT EXISTS + a column-existence
// guard keep the whole migration a pure no-op on replay (migrate() re-runs every up()).
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_encounters (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      episode_id   INTEGER NOT NULL REFERENCES illness_episodes(id),
      encounter_id INTEGER NOT NULL REFERENCES encounters(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_encounters_link
      ON episode_encounters(profile_id, episode_id, encounter_id);
    CREATE INDEX IF NOT EXISTS idx_episode_encounters_encounter
      ON episode_encounters(profile_id, encounter_id);
  `);

  // One-time data move: each existing non-null illness_episodes.encounter_id becomes a
  // link row, THEN the FK column is dropped. Guarded on the column's presence so a
  // replay (column already gone) skips the whole block — naturally idempotent.
  if (columnNames(db, "illness_episodes").has("encounter_id")) {
    db.exec(
      `INSERT OR IGNORE INTO episode_encounters (profile_id, episode_id, encounter_id)
         SELECT profile_id, id, encounter_id
           FROM illness_episodes
          WHERE encounter_id IS NOT NULL`
    );
    // Drop the index that references the column first (SQLite refuses DROP COLUMN on an
    // indexed column), then drop the column itself. SQLite ≥ 3.35 supports DROP COLUMN.
    db.exec(`DROP INDEX IF EXISTS idx_illness_episodes_encounter`);
    db.exec(`ALTER TABLE illness_episodes DROP COLUMN encounter_id`);
  }
}

export const migration: Migration = {
  id: 94,
  name: "094-episode-encounters",
  up,
};
