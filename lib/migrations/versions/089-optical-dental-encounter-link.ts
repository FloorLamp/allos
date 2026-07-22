import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 089 (issue #1099): finish the #1050 record ↔ visit link column set on the
// two visit-implying specialty tables it left out. #1050's migration 081 added
// `encounter_id` to medical_records / intake_items / conditions / procedures /
// imaging_studies / immunizations, and its own update note called for extending it to
// optical_prescriptions / dental_procedures too — but the shipped 081 did not include
// them. #1099 ("Create a visit from this record?") links the derived skeleton
// encounter to the source record via this SAME column, so an optical Rx and a dental
// procedure need it. imaging_studies already has it (081).
//
// House rules (CLAUDE.md, mirroring 081): a NULLABLE `REFERENCES` column added via
// ALTER TABLE ADD COLUMN DOES carry its FK, so this is a plain guarded ADD COLUMN per
// table. **No ON DELETE** — deleting an encounter NULLs these back-links first (the
// row-ops convention, nullEncounterLinks / deleteEncounter). The runner applies
// migrations with foreign_keys OFF and restores it, so the stored REFERENCES is
// enforced at runtime on the app's foreign_keys=ON connection. Both tables are already
// profile-owned (lib/owned-tables.ts) and already in the import footprint (their rows
// are cleared/moved/counted by document_id); the link is a column ON those rows, not a
// new footprint table.
//
// CREATE ... IF NOT EXISTS + the guarded ADD COLUMN keep the non-version-gated
// migrate() replay a pure no-op. Determinism: reads only the DB + its own constants.

const LINK_TABLES = ["optical_prescriptions", "dental_procedures"] as const;

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  for (const table of LINK_TABLES) {
    if (!columnNames(db, table).has("encounter_id")) {
      db.exec(
        `ALTER TABLE ${table} ADD COLUMN encounter_id INTEGER REFERENCES encounters(id)`
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_encounter
         ON ${table}(profile_id, encounter_id)`
    );
  }
}

export const migration: Migration = {
  id: 89,
  name: "089-optical-dental-encounter-link",
  up,
};
