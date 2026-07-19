import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 065 (issue #697): the structured optical-prescription record type — the
// eye-care enabler (#707 Phase 1) that unblocks the FHIR VisionPrescription mapper
// (#708, Phase 2). Mirrors the imaging-study (#702, migration 037) and genomic-variant
// (#709, migration 036) record types. Lands after 063-cycles (#989) and
// 064-login-email (#991), the two parallel-branch siblings it stacks behind.
//
// Before this table an eyeglass/contact prescription had no structured home: the
// sphere/cylinder/axis/add/PD fields existed nowhere in the schema, so an optical Rx
// (the document you show at every optician visit, whose HISTORY tells you whether
// myopia is progressing) could only be stored as an uploaded PDF — even though the
// eye-exam LOOP (the `vision_exam` preventive rule, the `vision` appointment kind)
// was already fully built. optical_prescriptions is the structured home for that
// artifact.
//
// Per-eye values follow standard optometry notation: OD = right eye, OS = left eye.
// sphere / cylinder / add are dioptres (REAL, may be negative); axis is a whole
// degree 0–180 (INTEGER). PD (pupillary distance, mm) is shared. The contacts-only
// extras (base_curve, diameter, brand) stay NULL for a glasses Rx. kind is the one
// low-cardinality classifier, CHECK-constrained and normalized in code
// (lib/optical-prescription.ts) so an import can't land an off-vocabulary value.
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`
// so it joins OWNED_TABLES (lib/owned-tables.ts). `document_id` carries a real
// REFERENCES FK to medical_documents (nullable, no ON DELETE) so it joins the import
// footprint keyed on document_id, exactly like conditions/procedures/imaging_studies.
// `provider_id` (the PRESCRIBER) carries a real REFERENCES FK into the global
// providers registry (nullable, no ON DELETE) so a provider merge re-points it
// (PROVIDER_LINK_COLUMNS) — the runner applies migrations with foreign_keys OFF and
// restores it, so every stored REFERENCES is enforced at runtime on the app's
// foreign_keys=ON connection.
//
// CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated migrate()
// replay a no-op. Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS optical_prescriptions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      kind          TEXT NOT NULL DEFAULT 'glasses' CHECK (
                      kind IN ('glasses', 'contacts')
                    ),
      od_sphere     REAL,
      od_cylinder   REAL,
      od_axis       INTEGER,
      od_add        REAL,
      os_sphere     REAL,
      os_cylinder   REAL,
      os_axis       INTEGER,
      os_add        REAL,
      pd            REAL,
      base_curve    REAL,
      diameter      REAL,
      brand         TEXT,
      issued_date   TEXT,
      expiry_date   TEXT,
      provider_id   INTEGER REFERENCES providers(id),
      notes         TEXT,
      source        TEXT,
      document_id   INTEGER REFERENCES medical_documents(id),
      external_id   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_optical_prescriptions_profile
      ON optical_prescriptions(profile_id, issued_date);
    CREATE INDEX IF NOT EXISTS idx_optical_prescriptions_document
      ON optical_prescriptions(document_id);
    CREATE INDEX IF NOT EXISTS idx_optical_prescriptions_kind
      ON optical_prescriptions(profile_id, kind);
  `);
}

export const migration: Migration = {
  id: 65,
  name: "065-optical-prescriptions",
  up,
};
