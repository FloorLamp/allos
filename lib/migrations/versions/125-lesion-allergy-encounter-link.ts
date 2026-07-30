import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 125 (issue #1526): close the last two encounter-link gaps in the
// profile-owned clinical tables. An FK sweep keyed on foreign-key TARGETS (not column
// names) found exactly two observation tables with no link to the visit that produced
// them: `skin_lesions` and `allergies`. Their own tab-siblings already carry it —
// `dental_procedures` (the other Records → Specialty observation, migration 089) and
// `conditions` (the other half of Records → Problems, migration 081) — so a single
// tab answers "which visit established this?" for one row family and not the other.
//
// WHY each column:
//
//   skin_lesions.encounter_id — `finding` and `follow_up_interval_days` are what a
//     dermatologist tells you AT AN APPOINTMENT. The workflow already spans both
//     sides and only half links: the biopsy (`procedures`) carries the encounter, the
//     lesion it came from does not, so a visit detail cannot show what that visit
//     found about your skin.
//
//   allergies.encounter_id + allergies.provider_id — an allergy had NO attribution of
//     any kind, yet it carries more attribution weight than most rows: it gates
//     drug-interaction warnings and prints on the emergency card. "Who documented
//     this, and at which visit" is what a clinician asks before trusting a listed
//     allergy, and it is the natural companion to the verification status (#1405):
//     a *confirmed* allergy means much more when you can see who confirmed it.
//
// House rules (CLAUDE.md, mirroring 081/089 exactly): a NULLABLE `REFERENCES` column
// added via ALTER TABLE ADD COLUMN DOES carry its FK (unlike attaching an FK to an
// existing column, which needs a table rebuild), so this is a plain guarded ADD COLUMN
// — no rebuild, so nothing to null beforehand. **No ON DELETE** on either link: the
// observation OUTLIVES the visit and the provider record, so deleting an encounter
// NULLs these back-links first (nullEncounterLinks / deleteEncounter, and the
// per-document delete/reassign loops in lib/import-persist) and a provider is only
// ever deleted inside mergeProviders, which re-points every link in
// PROVIDER_LINK_COLUMNS first (`allergies.provider_id` joins that bound list in this
// same change; `skin_lesions.provider_id` was already there). The runner applies
// migrations with foreign_keys OFF and restores it, so each stored REFERENCES is
// enforced at runtime on the app's foreign_keys=ON connection.
//
// Both tables are already profile-owned (lib/owned-tables.ts) and already in the
// import footprint (their rows are cleared/moved/counted by document_id) — a link is
// a column ON those rows, not a new footprint table, so neither registry changes.
//
// Every ADD COLUMN is guarded by a column-presence check so the non-version-gated
// migrate() replay is a pure no-op; production applies each exactly once behind the
// version gate. Determinism (spec): reads only the DB catalog + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const lesionCols = columnNames(db, "skin_lesions");
  if (!lesionCols.has("encounter_id")) {
    db.exec(
      `ALTER TABLE skin_lesions ADD COLUMN encounter_id INTEGER REFERENCES encounters(id)`
    );
  }

  const allergyCols = columnNames(db, "allergies");
  if (!allergyCols.has("encounter_id")) {
    db.exec(
      `ALTER TABLE allergies ADD COLUMN encounter_id INTEGER REFERENCES encounters(id)`
    );
  }
  if (!allergyCols.has("provider_id")) {
    db.exec(
      `ALTER TABLE allergies ADD COLUMN provider_id INTEGER REFERENCES providers(id)`
    );
  }

  // (profile_id, encounter_id) matches the 081/089 index shape: every read of these
  // links is profile-scoped and then filtered by the visit ("what came from this
  // visit?"), so the composite serves both that and the "is this row linked?" probe.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skin_lesions_encounter
      ON skin_lesions(profile_id, encounter_id);
    CREATE INDEX IF NOT EXISTS idx_allergies_encounter
      ON allergies(profile_id, encounter_id);
    CREATE INDEX IF NOT EXISTS idx_allergies_provider
      ON allergies(provider_id) WHERE provider_id IS NOT NULL;
  `);
}

export const migration: Migration = {
  id: 125,
  name: "125-lesion-allergy-encounter-link",
  up,
};
