import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 037 (issue #702): the structured imaging-study record type — the
// imaging enabler (#707 Phase 1) that unblocks the contrast-safety check (#701),
// the FHIR imaging mappers (#708), the follow-up loop (#700), and the imaging tail
// (#703). Mirrors the genomic-variant record type (#709, migration 036).
//
// Before this table imaging was only its byproducts: the report PDF was stored,
// numeric imaging METRICS (DEXA T-scores, coronary calcium, EF, IMT) extracted into
// the `scan` biomarker category (and stayed there — this migration does NOT touch
// that routing), and a coded imaging PROCEDURE could satisfy its preventive
// screening. But the STUDY itself — modality, body region, laterality, contrast,
// and above all the radiologist's IMPRESSION (which for most imaging IS the result)
// — had nowhere to live. imaging_studies is that narrative + metadata home; it
// LINKS to the scan metrics, it does not absorb them.
//
// Image pixels / DICOM are intentionally OUT of scope: Allos holds the REPORT, not
// the images. This path captures the structured report only.
//
// `indication` (the reason the study was ordered) is captured structurally so a
// later owner decision can distinguish a screening from a diagnostic study — it is
// STORED but NOT gated on here: today any imaging still satisfies its screening the
// same way it did before (the procedure-inference path is untouched).
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`
// so it joins OWNED_TABLES (lib/owned-tables.ts). `document_id` carries a real
// REFERENCES FK to medical_documents (nullable, no ON DELETE) so it joins the import
// footprint keyed on document_id, exactly like conditions/procedures. The two
// provider links (`ordering_provider_id` / `reading_provider_id`) carry real
// REFERENCES FKs into the global providers registry (nullable, no ON DELETE) so a
// provider merge re-points them (PROVIDER_LINK_COLUMNS) — the runner applies
// migrations with foreign_keys OFF and restores it, so every stored REFERENCES is
// enforced at runtime on the app's foreign_keys=ON connection.
//
// The CHECK sets are the two low-cardinality classifiers (modality + laterality),
// kept small and normalized in code (lib/imaging-study.ts) so an import can't land
// an off-vocabulary value; body_region / impression / indication stay free text.
// CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated migrate()
// replay a no-op. Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS imaging_studies (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id           INTEGER NOT NULL REFERENCES profiles(id),
      modality             TEXT NOT NULL DEFAULT 'other' CHECK (
                             modality IN (
                               'x-ray','ct','mri','ultrasound','dexa','other'
                             )
                           ),
      body_region          TEXT,
      laterality           TEXT CHECK (
                             laterality IN ('left','right','bilateral','na')
                             OR laterality IS NULL
                           ),
      contrast             INTEGER NOT NULL DEFAULT 0 CHECK (contrast IN (0, 1)),
      contrast_agent       TEXT,
      study_date           TEXT,
      impression           TEXT,
      indication           TEXT,
      status               TEXT,
      ordering_provider_id INTEGER REFERENCES providers(id),
      reading_provider_id  INTEGER REFERENCES providers(id),
      notes                TEXT,
      source               TEXT,
      document_id          INTEGER REFERENCES medical_documents(id),
      external_id          TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_imaging_studies_profile
      ON imaging_studies(profile_id, study_date);
    CREATE INDEX IF NOT EXISTS idx_imaging_studies_document
      ON imaging_studies(document_id);
    CREATE INDEX IF NOT EXISTS idx_imaging_studies_modality
      ON imaging_studies(profile_id, modality);
  `);
}

export const migration: Migration = {
  id: 37,
  name: "037-imaging-studies",
  up,
};
