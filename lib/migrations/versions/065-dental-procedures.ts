import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 065 (issue #705): the structured DENTAL record type — the dental
// enabler (#707 Phase 1) that unblocks the dental-procedure safety checks (#704,
// the planned-procedure signal) and supplies the dental adapter for the finding →
// follow-up → resolution chain (#700, core shipped in migration 050). Mirrors the
// imaging-study record type (#702, migration 037) and the genomic-variant type
// (#709, migration 036).
//
// STORAGE DECISION (argued in the PR): dental splits across three homes by the
// #860/#944 observation-substrate rule —
//   • tooth-aware PROCEDURES (a filling/crown/extraction/root-canal anchored to a
//     tooth + surface + CDT code) have NO existing home — the general `procedures`
//     table carries name+code+date but no tooth notation, so per-tooth history is
//     impossible — so this ONE net-new table holds them, plus the dental exam
//     FINDINGS ("watch #14, recheck in 6 months") that seed the follow-up loop.
//   • periodontal MEASUREMENTS (probing depth, bleeding-on-probing) are dated
//     per-subject readings → they REUSE the medical_records biomarker store as
//     curated canonical analytes (the IOP/vision-analyte precedent, #698), NOT a
//     parallel readings table, so they trend + flag on the existing Biomarkers
//     surface for free.
//   • dental X-rays are imaging studies (#702) — NOT modeled here.
//
// dental_procedures is ONE profile-OWNED table, born `profile_id INTEGER NOT NULL
// REFERENCES profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts).
// `document_id` carries a real REFERENCES FK to medical_documents (nullable, no ON
// DELETE) so it joins the import footprint keyed on document_id, exactly like
// imaging_studies/conditions/procedures. `provider_id` carries a real REFERENCES FK
// into the global providers registry (nullable, no ON DELETE) so a provider merge
// re-points it (PROVIDER_LINK_COLUMNS). The runner applies migrations with
// foreign_keys OFF and restores it, so every stored REFERENCES is enforced at
// runtime on the app's foreign_keys=ON connection.
//
// The `status` CHECK is the low-cardinality classifier that gates BOTH downstream
// consumers: 'planned' is #704's planned-procedure signal (a planned invasive
// procedure), 'watch' is a monitored exam finding that seeds a dental follow-up,
// 'completed' is history. `tooth_system` normalizes the notation origin. tooth /
// surface / cdt_code / name / finding / notes stay free text (normalized in code,
// lib/dental-procedure.ts, so an import can't land an off-vocabulary status).
//
// This migration ALSO extends the care_plan_items follow-up chain (#700) with the
// DENTAL adapter's two nullable link columns — source_dental_procedure_id (the
// exam finding that motivated a recheck) and resolved_by_dental_procedure_id (the
// later dental record the resolution was recorded against) — exactly as migration
// 050 added the imaging links and 060 the medical_records links. SQLite permits a
// REFERENCES clause on a BRAND-NEW nullable column (default NULL), so no
// create→copy→drop→rename dance is needed.
//
// CREATE ... IF NOT EXISTS + the index guards + the ADD COLUMN presence checks keep
// the non-version-gated migrate() replay a no-op. Determinism (spec): reads only the
// DB catalog + its own constants.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dental_procedures (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL REFERENCES profiles(id),
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'completed' CHECK (
                      status IN ('completed', 'planned', 'watch')
                    ),
      tooth         TEXT,
      tooth_system  TEXT CHECK (
                      tooth_system IN ('universal', 'fdi', 'palmer')
                      OR tooth_system IS NULL
                    ),
      surface       TEXT,
      cdt_code      TEXT,
      procedure_date TEXT,
      finding       TEXT,
      follow_up_interval_days INTEGER,
      provider_id   INTEGER REFERENCES providers(id),
      notes         TEXT,
      source        TEXT,
      document_id   INTEGER REFERENCES medical_documents(id),
      external_id   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dental_procedures_profile
      ON dental_procedures(profile_id, procedure_date);
    CREATE INDEX IF NOT EXISTS idx_dental_procedures_document
      ON dental_procedures(document_id);
    CREATE INDEX IF NOT EXISTS idx_dental_procedures_tooth
      ON dental_procedures(profile_id, tooth);
    CREATE INDEX IF NOT EXISTS idx_dental_procedures_status
      ON dental_procedures(profile_id, status);
  `);

  // Extend the care_plan_items follow-up chain with the dental adapter's links
  // (mirrors migration 050's imaging links / 060's medical_records links). Guarded
  // behind column-presence checks so the non-version-gated migrate() replay is a
  // no-op; production applies each ADD COLUMN exactly once behind the version gate.
  const cols = new Set(columnNames(db, "care_plan_items"));
  if (cols.size > 0) {
    if (!cols.has("source_dental_procedure_id")) {
      db.exec(
        `ALTER TABLE care_plan_items
           ADD COLUMN source_dental_procedure_id INTEGER REFERENCES dental_procedures(id);`
      );
    }
    if (!cols.has("resolved_by_dental_procedure_id")) {
      db.exec(
        `ALTER TABLE care_plan_items
           ADD COLUMN resolved_by_dental_procedure_id INTEGER REFERENCES dental_procedures(id);`
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_care_plan_items_source_dental
         ON care_plan_items(source_dental_procedure_id)
         WHERE source_dental_procedure_id IS NOT NULL;`
    );
  }
}

export const migration: Migration = {
  id: 65,
  name: "065-dental-procedures",
  up,
};
