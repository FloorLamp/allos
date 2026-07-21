import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 082 (issue #1053): illness episode → resulting visit link. A nullable
// `encounter_id INTEGER REFERENCES encounters(id)` on illness_episodes — the same
// mechanism as #1050 (migration 081), one more edge. An encounter dated WITHIN an
// episode's range (start → lastActiveDay, exact containment) is a read-time strong
// suggestion the caregiver accepts; the accept sets this column, decline is
// remembered in visit_link_decisions (domain 'episode').
//
// House rules: nullable REFERENCES column added via ALTER TABLE ADD COLUMN carries
// its FK; NO ON DELETE — deleting an encounter NULLs this back-link first (the
// row-ops convention, deleteEncounter). illness_episodes is already profile-owned;
// this adds a column, not a table. Guarded ADD COLUMN keeps the replay a no-op.
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "illness_episodes").has("encounter_id")) {
    db.exec(
      `ALTER TABLE illness_episodes
         ADD COLUMN encounter_id INTEGER REFERENCES encounters(id)`
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_illness_episodes_encounter
       ON illness_episodes(profile_id, encounter_id)`
  );
}

export const migration: Migration = {
  id: 82,
  name: "082-episode-visit-link",
  up,
};
