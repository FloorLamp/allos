import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 076 (issue #1034): grow the imaging_studies.modality CHECK with the
// three high-dose modalities the enum omitted — 'pet', 'nuclear-medicine'
// (SPECT/scintigraphy), and 'fluoroscopy' (incl. interventional angiography,
// whose dose mechanism is fluoroscopic).
//
// Before this, every PET / nuclear / fluoro study normalized to 'other', which
// has no typical-dose dataset entry (the refusal gate), so the cumulative
// radiation total silently understated for exactly the patients getting the most
// radiation — a false-LOW on a safety-relevant metric. The code side
// (normalizeModality branches, modalityLabel, the radiation-dose dataset
// entries, IONIZING_MODALITIES) ships in the same change; this migration lets
// the DB accept the new values.
//
// SQLite can't alter a CHECK in place, so this is the documented rebuild:
// create-scratch → copy → drop → rename (matching migrations 006/011/018).
// Existing rows all hold values the wider CHECK admits, so the copy is verbatim;
// ids are preserved so the care_plan_items follow-up links
// (source_imaging_study_id / resolved_by_imaging_study_id) stay valid — the
// runner (and the migrate() test wrapper) apply every migration with
// foreign_keys OFF and restore it after, so dropping the FK-parent table never
// cascade-wipes referencing rows.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an
// already-converged DB, so the rebuild is guarded by a sentinel read off the
// live schema (the CHECK listing 'pet' — a value only the new CHECK introduces);
// a second run is a pure no-op. Production runs it once behind the user_version
// gate. Determinism (spec): reads only the DB + its own constants.
//
// The scratch table is named `imaging_studies__new` (ending in `_new`) on
// purpose: it declares profile_id, and the profile-scoping owned-table scanner
// skips names ending in `_new` (the migration-018 precedent).

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "imaging_studies");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (sql.includes("'pet'")) return; // already converged (new CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE imaging_studies__new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id           INTEGER NOT NULL REFERENCES profiles(id),
        modality             TEXT NOT NULL DEFAULT 'other' CHECK (
                               modality IN (
                                 'x-ray','ct','mri','ultrasound','dexa',
                                 'pet','nuclear-medicine','fluoroscopy',
                                 'other'
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
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        dose_msv             REAL
      );
      INSERT INTO imaging_studies__new
        (id, profile_id, modality, body_region, laterality, contrast,
         contrast_agent, study_date, impression, indication, status,
         ordering_provider_id, reading_provider_id, notes, source,
         document_id, external_id, created_at, dose_msv)
        SELECT
         id, profile_id, modality, body_region, laterality, contrast,
         contrast_agent, study_date, impression, indication, status,
         ordering_provider_id, reading_provider_id, notes, source,
         document_id, external_id, created_at, dose_msv
        FROM imaging_studies;
      DROP TABLE imaging_studies;
      ALTER TABLE imaging_studies__new RENAME TO imaging_studies;
      CREATE INDEX IF NOT EXISTS idx_imaging_studies_profile
        ON imaging_studies(profile_id, study_date);
      CREATE INDEX IF NOT EXISTS idx_imaging_studies_document
        ON imaging_studies(document_id);
      CREATE INDEX IF NOT EXISTS idx_imaging_studies_modality
        ON imaging_studies(profile_id, modality);
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 76,
  name: "076-imaging-modality-expansion",
  up,
};
