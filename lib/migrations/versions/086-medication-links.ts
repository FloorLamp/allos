import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 083 (issues #1051 + #1052): two nullable back-reference columns on
// intake_items, applied as a coupled change (one PR):
//
//   - source_record_id INTEGER REFERENCES medical_records(id)  (#1051)
//       The prescription medical_records row a structured medication was projected
//       from (the records bridge / auto-import). Buys the provenance chain and the
//       transitive "Prescribed at" payoff: once #1050 links that record to its
//       visit, the med resolves the visit THROUGH the record.
//   - indication_condition_id INTEGER REFERENCES conditions(id) (#1052)
//       The condition a medication treats ("what is this med for"). Tier-1 is the
//       FHIR MedicationRequest.reasonReference resolved in-bundle; tier-2 is a
//       read-time text-match the user accepts; manual is the med form picker.
//
// House rules (CLAUDE.md): a NULLABLE `REFERENCES` column added via ALTER TABLE ADD
// COLUMN DOES carry its FK (unlike attaching an FK to an existing column, which
// needs a table rebuild), so this is a plain guarded ADD COLUMN. **No ON DELETE** —
// deleting the source record / condition NULLs these back-links FIRST (the row-ops
// convention: clearImportedDocumentRows + moveImportedDocumentRows + the standalone
// record/condition delete cores null them before the parent row goes). The runner
// applies migrations with foreign_keys OFF and restores it, so the stored REFERENCES
// is enforced at runtime on the app's foreign_keys=ON connection.
//
// intake_items is ALREADY profile-owned (OWNED_TABLES) and ALREADY an import-footprint
// row (extracted meds keyed on document_id AND source='extracted'), so these columns
// join the footprint by riding on rows the footprint already clears/moves/counts — no
// new footprint TABLE. Guarded ADD COLUMN + CREATE INDEX IF NOT EXISTS keep the
// non-version-gated migrate() replay a pure no-op.
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "intake_items");
  if (!cols.has("source_record_id")) {
    db.exec(
      `ALTER TABLE intake_items
         ADD COLUMN source_record_id INTEGER REFERENCES medical_records(id)`
    );
  }
  if (!cols.has("indication_condition_id")) {
    db.exec(
      `ALTER TABLE intake_items
         ADD COLUMN indication_condition_id INTEGER REFERENCES conditions(id)`
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_items_source_record
       ON intake_items(profile_id, source_record_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_items_indication_condition
       ON intake_items(profile_id, indication_condition_id)`
  );
}

export const migration: Migration = {
  id: 86,
  name: "086-medication-links",
  up,
};
