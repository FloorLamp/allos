import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 075 (issue #1035): the encounter TYPE CODE — the CPT/CDT/SNOMED
// coding both importers already parse for the display text and then drop. The
// preventive concept map's visit rules carry exact code sets (adult_physical →
// CPT 99396/…, dental_cleaning → CDT D0120/…, vision_exam → CPT 92014/…)
// precisely so a coded record can satisfy them without title guessing, but with
// no stored code an imported "Office Visit" carrying 99396 could never match —
// a false "overdue physical" nag with the disproving record already imported.
//
// Two nullable ADD COLUMNs on the existing encounters table, mirroring the
// code/code_system pair conditions/procedures were born with: `code` (the
// encounter type code, e.g. "99396"/"D0120") and `code_system` (its labeled
// vocabulary, e.g. "CPT"). The CCDA mapper fills them from the encounter
// <code> (skipping the ActEncounterCode class translation, which already lands
// in class_code); the FHIR mapper from Encounter.type[].coding. Manual
// encounters leave them NULL. Display `type`, dedup external_id, and the
// representative-collapse content key are all unchanged (#1035 ask 3).
//
// ADD COLUMN runs exactly once behind the version gate, but the
// non-version-gated migrate() replay used by the DB-tier tests re-applies
// migrations against an already-current schema, so each add is wrapped to
// no-op when the column exists (SQLite has no ADD COLUMN IF NOT EXISTS).
// Determinism (spec): reads only the DB catalog + its own constants.

export function up(db: Database.Database): void {
  const cols = new Set(
    (
      db.prepare(`PRAGMA table_info(encounters)`).all() as { name: string }[]
    ).map((c) => c.name)
  );
  if (!cols.has("code")) {
    db.exec(`ALTER TABLE encounters ADD COLUMN code TEXT`);
  }
  if (!cols.has("code_system")) {
    db.exec(`ALTER TABLE encounters ADD COLUMN code_system TEXT`);
  }
}

export const migration: Migration = {
  id: 75,
  name: "075-encounter-type-code",
  up,
};
