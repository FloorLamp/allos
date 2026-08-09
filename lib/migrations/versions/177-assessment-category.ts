import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { reclassifyNonAnalyteObservations } from "../../assessment-reclass-db";

// Migration 177 (issue #2318): grow the medical_records `category` CHECK to admit
// `assessment` — the non-measurement class a CCD observation lands in when it states
// no measurement and claims no analyte identity: a functional-status finding, the
// body SITE a temperature was taken at, an individual questionnaire ITEM's free-text
// answer, a generic result-status word — and then RE-HOME the rows already stored
// under `lab`, together with everything that took a NAME from them.
//
// WHY a migration for the CHECK: the CCD importer now stores category = 'assessment'
// (lib/cda/extractors/observations.ts). The prior CHECK — grown by 090 and 106 —
// would 500 those inserts. SQLite cannot alter a CHECK in place, so the table is
// rebuilt to its final shape with the grown CHECK: the standard
// create→copy→drop→rename, exactly like migrations 006 / 090 / 106. The rebuilt
// CREATE below is migration 106's shape plus every column later migrations ALTERed
// on (result_status / fasting / specimen / ordering_provider_id from 120 and 136,
// occurred_at from 165), so the converged table is byte-comparable to what a fresh
// database reaches by replaying 001 → 176.
//
// WHY a backfill as well, unlike 106: this category is NOT brand new to the data. The
// rows exist; they are just filed under `lab`, where each acquired an ai-coined
// `canonical_biomarkers` name, a permanent slot under Data → Coverage → Uncatalogued
// items, and a bandless "biomarker" series. A forward-only fix would leave every
// database that has ever imported a CCD showing them forever — so the one-shot data
// move belongs here (AGENTS.md: "Put one-shot data moves in a migration, not a
// settings flag"), the same shape #2306's pass took in migration 174. The move and
// its name-keyed cleanup live in lib/assessment-reclass-db.ts, which documents
// exactly which rows it claims, which tables took a name from them, and what it
// deliberately leaves alone.
//
// NO BOOT TASK, unlike #2306's. That pass needed one because CANONICAL_ALIASES grows
// in releases with no schema change, so fresh drift can appear between two boots.
// Here the parse fix is what stops new rows, and it ships in the same build as this
// migration — there is no window in which a post-177 import can mint the shape again.
//
// FK / CASCADE SAFETY: medical_records is a FK PARENT (care_plan_items, intake_items,
// instrument_responses, followup_labs reference its id). The runner applies every
// migration with foreign_keys DISABLED (see runner.ts), so the DROP doesn't
// cascade-wipe the children; they reference `medical_records` by NAME and follow the
// RENAME onto the rebuilt table. Ids are preserved by the INSERT…SELECT, so every
// child FK stays resolved. Any dangling nullable link (provider_id / document_id /
// encounter_id / ordering_provider_id) is nulled pre-copy so the re-enabled FK meets
// a clean graph.
//
// REPLAY SAFETY (the non-version-gated migrate() test wrapper replays up()
// unconditionally): the rebuild is skipped when the live table already carries the
// grown CHECK (the `SENTINEL`), and the backfill is idempotent by construction — a
// second run finds no `lab` candidates because the first run moved them.
//
// Profile-AGNOSTIC by design (allowlisted in lib/__tests__/profile-scoping.test.ts):
// a one-shot schema rebuild that copies every column verbatim, never reading one
// profile's data into another's. The backfill it then calls IS profile-scoped, per
// profile, in its own module.

// The rebuilt table's FINAL shape: the live post-165 shape with `assessment` added to
// the category CHECK.
const CREATE = `
  CREATE TABLE medical_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    date TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('vitals','lab','genomics','biomarker','scan','prescription','instrument','derived','reference','report','assessment')),
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
    encounter_id INTEGER REFERENCES encounters(id),
    result_status TEXT
      CHECK (result_status IS NULL OR result_status IN ('preliminary','final','corrected','amended')),
    fasting INTEGER
      CHECK (fasting IS NULL OR fasting IN (0, 1)),
    specimen TEXT,
    ordering_provider_id INTEGER REFERENCES providers(id),
    occurred_at TEXT
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
  { column: "ordering_provider_id", parent: "providers" },
];

// Present ONLY in the converged CHECK — its presence in the live table SQL
// short-circuits a replay.
const SENTINEL = "'report','assessment'";

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

  const oldCols = new Set(columnNames(db, "medical_records"));
  // Null any dangling nullable link so the deferred FK check at commit can't fail.
  // A column the live table doesn't have (a partial handle, or a minimal fixture) is
  // skipped rather than assumed.
  for (const { column, parent } of LINKS) {
    if (!oldCols.has(column)) continue;
    db.exec(
      `UPDATE medical_records SET ${column} = NULL
         WHERE ${column} IS NOT NULL
           AND ${column} NOT IN (SELECT id FROM ${parent});`
    );
  }

  const scratch = "medical_records__new177";
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
    // Only AFTER the CHECK admits it — the backfill's UPDATE writes 'assessment'.
    reclassifyNonAnalyteObservations(db);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 177,
  name: "177-assessment-category",
  up,
};
