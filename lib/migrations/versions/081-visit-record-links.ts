import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 081 (issue #1050): record ↔ visit linking. A nullable
// `encounter_id INTEGER REFERENCES encounters(id)` on every visit-anchored record
// table, plus the `visit_link_decisions` table that persists the user's
// suggest-and-accept choices across a reprocess.
//
// The columns are the deterministic tier-1 target (a FHIR MedicationRequest.encounter
// / Observation.encounter reference resolved to the local encounter row at persist)
// AND the tier-2 target (a read-time date/provider suggestion the user accepts). Six
// tables get the column: prescription-category medical_records (the highest-volume
// case — one column lights up every lab/vital/prescription), the intake_items a
// prescription is projected into, conditions (visit diagnoses), procedures,
// imaging_studies, and immunizations (given at a visit).
//
// House rules (CLAUDE.md): a NULLABLE `REFERENCES` column added via ALTER TABLE ADD
// COLUMN DOES carry its FK (unlike attaching an FK to an existing column, which needs
// a table rebuild), so this is a plain guarded ADD COLUMN per table. **No ON DELETE**
// — deleting an encounter NULLs these back-links first (the row-ops convention, the
// deleteEncounter / appointments.encounter_id precedent from migration 026). The
// runner applies migrations with foreign_keys OFF and restores it, so the stored
// REFERENCES is enforced at runtime on the app's foreign_keys=ON connection. The
// columns join lib/owned-tables.ts implications (they live on already-owned tables)
// and the import footprint (their rows are cleared/moved/counted by document_id as
// before — the link is a column ON those rows, not a new footprint table).
//
// visit_link_decisions is a NEW profile-OWNED table (joins OWNED_TABLES). It mirrors
// import_pair_decisions: a durable, stable-key decision that survives the
// delete-and-reinsert reprocess. Both sides are keyed by a STABLE identity token
// (`ext:<external_id>` for an imported row, `id:<n>` for a manual one — the
// import-review activityToken precedent), so an accepted link re-applies and a
// declined pair stays suppressed after the row ids churn on reprocess.
//
// CREATE ... IF NOT EXISTS + the guarded ADD COLUMNs keep the non-version-gated
// migrate() replay a pure no-op. Determinism: reads only the DB + its own constants.

// The visit-anchored record tables that gain `encounter_id` (#1050).
const LINK_TABLES = [
  "medical_records",
  "intake_items",
  "conditions",
  "procedures",
  "imaging_studies",
  "immunizations",
] as const;

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS visit_link_decisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      -- Which record family the target token names:
      -- 'record' | 'condition' | 'procedure' | 'imaging' | 'immunization'
      -- | 'medication' | 'episode' (episode is #1053, same table/pattern).
      domain       TEXT NOT NULL,
      -- The encounter's STABLE identity token ('ext:<external_id>' | 'id:<n>').
      encounter_key TEXT NOT NULL,
      -- The linked row's STABLE identity token (same shape; 'id:<episodeId>' for
      -- an episode, whose ids are stable).
      target_key   TEXT NOT NULL,
      decision     TEXT NOT NULL CHECK (decision IN ('linked','declined')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_link_decisions_key
      ON visit_link_decisions(profile_id, domain, encounter_key, target_key);
  `);
}

export const migration: Migration = {
  id: 81,
  name: "081-visit-record-links",
  up,
};
