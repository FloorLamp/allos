import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 036 (issue #709): the structured genomic-variant record type — the
// genomics enabler (#707 Phase 1) that unblocks the PGx cross-check (#710) and the
// hereditary-risk → screening-cadence consumer (#711).
//
// Before this table a genetic result was only a flat medical_records row (a name +
// value string), so "BRCA1 pathogenic variant", "CYP2C19 *2/*2", "APOE ε3/ε4" were
// free text nothing downstream could act on. genomic_variants captures the REPORTED
// variant structurally: the gene (HGNC symbol), the variant (rsID and/or HGVS), the
// genotype / star-allele / zygosity, ACMG clinical significance, and — the load-
// bearing routing key — a `result_type` discriminator that sends a variant to the
// PGx consumer (`pharmacogenomic`) vs the cadence consumer (`hereditary-risk`).
//
// Sensitivity: variant data is the most identifying PHI in the app. It is stored
// FACTUALLY with no risk editorializing, and — like the rest of the passport — its
// only sanctioned egress is the AI extraction of a document the user explicitly
// uploaded (a variant/gene name never reaches any other external API). Raw genotype
// files (23andMe/Ancestry/VCF) are OUT of scope (that's the future tier #712) — this
// path imports clinical genetics / PGx REPORTS only.
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES profiles(id)`
// so it joins OWNED_TABLES (lib/owned-tables.ts) — that single edit propagates to
// deleteProfile and the profile-scoping leak test. `document_id` carries a real
// REFERENCES FK to medical_documents (nullable, no ON DELETE action) so it joins the
// import footprint keyed on document_id, exactly like conditions/procedures — the
// runner applies migrations with foreign_keys OFF and restores it, so the stored
// REFERENCES is enforced at runtime on the app's foreign_keys=ON connection.
//
// The CHECK sets are the two ROUTING discriminators (result_type + significance),
// kept small and normalized in code (lib/genomic-variant.ts) so an import can't land
// an off-vocabulary value; genotype/star-allele/zygosity stay lighter-weight text.
// CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated migrate()
// replay a no-op. Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS genomic_variants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      gene          TEXT NOT NULL,
      variant       TEXT,
      genotype      TEXT,
      star_allele   TEXT,
      zygosity      TEXT CHECK (
                      zygosity IN ('heterozygous','homozygous','hemizygous')
                      OR zygosity IS NULL
                    ),
      significance  TEXT CHECK (
                      significance IN (
                        'pathogenic','likely-pathogenic','uncertain-significance',
                        'likely-benign','benign'
                      ) OR significance IS NULL
                    ),
      result_type   TEXT NOT NULL DEFAULT 'other' CHECK (
                      result_type IN (
                        'pharmacogenomic','hereditary-risk','carrier',
                        'diagnostic','other'
                      )
                    ),
      interpretation TEXT,
      source_lab    TEXT,
      report_date   TEXT,
      notes         TEXT,
      source        TEXT,
      document_id   INTEGER REFERENCES medical_documents(id),
      external_id   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_genomic_variants_profile
      ON genomic_variants(profile_id, gene COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_genomic_variants_document
      ON genomic_variants(document_id);
    CREATE INDEX IF NOT EXISTS idx_genomic_variants_result_type
      ON genomic_variants(profile_id, result_type);
  `);
}

export const migration: Migration = {
  id: 36,
  name: "036-genomic-variants",
  up,
};
