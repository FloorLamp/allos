import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 024 (issue #416): import-provenance columns on appointments.
//
// The appointments table had a full model (provider link, status lifecycle, kind,
// Upcoming surface) but NO import path could populate it — a FHIR/SHC Appointment
// resource was dropped because the bundle importer had no mapper, and CDA has no
// appointment section. Adding the FHIR Appointment mapper means imported rows must
// trace back to their source document exactly like the other clinical domains, so
// the import-footprint contract (clearImportedDocumentRows / moveImportedDocumentRows
// / countImportedDocumentRows) can delete/reassign/count them.
//
// So mirror the encounters table's import-provenance triple:
//   - document_id: the source document (the footprint key — appointments joins the
//     footprint as a document_id-keyed table);
//   - source: the document source string ("document:<id>"), for symmetry with the
//     other tables;
//   - external_id: the source's stable dedup key ("fhir:appointment:<id>"), so a
//     reprocess is idempotent within a document.
// All nullable: a manually-created appointment leaves them NULL and is therefore
// never touched by a document delete/reassign — the same manual-vs-import separation
// every other domain keeps.
//
// OPTIONAL + replay-safe: existing rows stay NULL, and each ADD COLUMN is guarded on
// PRAGMA table_info so the non-version-gated `migrate()` test wrapper (which replays
// every migration) doesn't hit "duplicate column name"; production applies it exactly
// once behind the user_version gate. Determinism: reads only the DB + its own
// constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "appointments");
  if (!cols.has("document_id")) {
    db.exec(`ALTER TABLE appointments ADD COLUMN document_id INTEGER;`);
  }
  if (!cols.has("source")) {
    db.exec(`ALTER TABLE appointments ADD COLUMN source TEXT;`);
  }
  if (!cols.has("external_id")) {
    db.exec(`ALTER TABLE appointments ADD COLUMN external_id TEXT;`);
  }
}

export const migration: Migration = {
  id: 24,
  name: "024-appointment-import-provenance",
  up,
};
