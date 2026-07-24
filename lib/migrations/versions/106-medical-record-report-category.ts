import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 106 (issue #708): grow the medical_records `category` CHECK to admit
// the narrative-report class `report` — the free-text body of a microbiology
// culture / gram stain / cytopathology diagnostic report, recovered from CCD/XDM
// Results-section observations whose <value xsi:type="ED"> resolves to narrative
// text (lib/cda/extractors/observations.ts). The report body rides in `notes` with
// value/value_num NULL, so it never trends or flags; it surfaces on Results →
// Reports.
//
// WHY a migration: the CCD importer now stores category = 'report'. The prior CHECK
// (…'instrument','derived','reference') — grown by migration 090 — would 500 those
// inserts. SQLite cannot alter a CHECK in place, so the table is rebuilt to its final
// shape with the grown CHECK — the standard create→copy→drop→rename, exactly like
// migrations 006 / 090.
//
// NO BACKFILL: unlike 090, this adds a brand-new category with no pre-existing rows to
// re-home. Every stored row keeps its category untouched; only future report inserts
// use the new value.
//
// FK / CASCADE SAFETY: medical_records is a FK PARENT (care_plan_items, intake_items,
// instrument_responses reference its id). The runner applies every migration with
// foreign_keys DISABLED (see runner.ts), so the DROP doesn't cascade-wipe the children;
// they reference `medical_records` by NAME and follow the RENAME onto the rebuilt table.
// Ids are preserved by the INSERT…SELECT, so every child FK stays resolved. Any dangling
// nullable link (provider_id/document_id/encounter_id) is nulled pre-copy so the
// re-enabled FK meets a clean graph.
//
// REPLAY SAFETY (the non-version-gated migrate() test wrapper replays up()
// unconditionally): the rebuild is skipped when the live table already carries the
// grown CHECK (the `SENTINEL`). Production runs it exactly once behind the
// user_version gate.
//
// Profile-AGNOSTIC by design (allowlisted in lib/__tests__/profile-scoping.test.ts):
// a one-shot schema rebuild that copies every column verbatim, never reading one
// profile's data into another's.

// The rebuilt table's FINAL shape: the migration-090 shape with `report` added to the
// category CHECK. Every other column/default is byte-for-byte migration 090's CREATE.
const CREATE = `
  CREATE TABLE medical_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    date TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('vitals','lab','genomics','biomarker','scan','prescription','instrument','derived','reference','report')),
    name TEXT NOT NULL,
    value TEXT,
    unit TEXT,
    reference_range TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT,
    external_id TEXT,
    provider_id INTEGER REFERENCES providers(id),
    document_id INTEGER REFERENCES medical_documents(id),
    panel TEXT,
    flag TEXT,
    value_num REAL,
    canonical_name TEXT,
    edited INTEGER NOT NULL DEFAULT 0,
    loinc TEXT,
    encounter_id INTEGER REFERENCES encounters(id)
  );`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_medical_document ON medical_records(document_id);",
  "CREATE INDEX IF NOT EXISTS idx_medical_canonical_ci ON medical_records(profile_id, canonical_name COLLATE NOCASE, date);",
  "CREATE INDEX IF NOT EXISTS idx_medical_profile_date ON medical_records(profile_id, date);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_medical_external ON medical_records(profile_id, external_id) WHERE external_id IS NOT NULL;",
  "CREATE INDEX IF NOT EXISTS idx_medical_records_profile_created ON medical_records(profile_id, created_at);",
  "CREATE INDEX IF NOT EXISTS idx_medical_records_encounter ON medical_records(profile_id, encounter_id);",
];

// Nullable link columns → their parent; a dangling value is nulled before the FK'd copy.
const LINKS: { column: string; parent: string }[] = [
  { column: "provider_id", parent: "providers" },
  { column: "document_id", parent: "medical_documents" },
  { column: "encounter_id", parent: "encounters" },
];

// Present ONLY in the converged CHECK — its presence in the live table SQL short-circuits a replay.
const SENTINEL = "'reference','report'";

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

function rebuildMedicalRecords(db: Database.Database): void {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'`
    )
    .get() as { sql: string | null } | undefined;
  const sql = row?.sql ?? null;
  if (sql === null) return; // partial handle — nothing to converge
  if (sql.includes(SENTINEL)) return; // already grown — replay no-op

  // Null any dangling nullable link so the deferred FK check at commit can't fail.
  for (const { column, parent } of LINKS) {
    db.exec(
      `UPDATE medical_records SET ${column} = NULL
         WHERE ${column} IS NOT NULL
           AND ${column} NOT IN (SELECT id FROM ${parent});`
    );
  }

  const oldCols = new Set(columnNames(db, "medical_records"));
  const scratch = "medical_records__new106";
  db.exec(
    CREATE.replace(
      "CREATE TABLE medical_records (",
      `CREATE TABLE ${scratch} (`
    )
  );
  const copyCols = columnNames(db, scratch).filter((c) => oldCols.has(c));
  const colList = copyCols.join(", ");
  db.exec(
    `INSERT INTO ${scratch} (${colList}) SELECT ${colList} FROM medical_records;`
  );
  db.exec(`DROP TABLE medical_records;`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO medical_records;`);
  for (const idx of INDEXES) db.exec(idx);
}

export function up(db: Database.Database): void {
  // MUST be applied with foreign_keys disabled — the runner and the migrate() test
  // wrapper both toggle it off around migration application (issue #95) so the
  // FK-parent rebuild can drop its table without its children being wiped. Wrapped in
  // one (possibly nested) transaction for atomicity: the runner already wraps up() in
  // an IMMEDIATE transaction (this nests as a SAVEPOINT); migrate() calls up() in
  // autocommit (this becomes the transaction).
  const run = db.transaction(() => {
    rebuildMedicalRecords(db);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 106,
  name: "106-medical-record-report-category",
  up,
};
