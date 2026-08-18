import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import { reclassifyLegacyBiomarkerCategory } from "../../legacy-category-reclass-db";

// Issue #2877 completes the retirement started by migration 185. The canonical
// registry gets one final evidence-only pass. Rows it still cannot classify are not
// guessed into lab or vitals: category becomes NULL, the explicit review state the
// Results surface presents to the user. The row stays in medical_records with the same
// id, so documents, revisions, care-plan links, saved identity, and dismissals remain
// attached while classification is pending.

const CREATE = `
  CREATE TABLE medical_records__new_2877 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    date TEXT NOT NULL,
    category TEXT
      CHECK (category IN ('vitals','lab','genomics','scan','prescription','instrument','derived','reference','report','assessment')),
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
  "CREATE INDEX idx_medical_document ON medical_records(document_id);",
  "CREATE INDEX idx_medical_canonical_ci ON medical_records(profile_id, canonical_name COLLATE NOCASE, date);",
  "CREATE INDEX idx_medical_profile_date ON medical_records(profile_id, date);",
  "CREATE UNIQUE INDEX idx_medical_external ON medical_records(profile_id, external_id) WHERE external_id IS NOT NULL;",
  "CREATE INDEX idx_medical_records_profile_created ON medical_records(profile_id, created_at);",
  "CREATE INDEX idx_medical_records_encounter ON medical_records(profile_id, encounter_id);",
];

const COLUMNS = [
  "id",
  "profile_id",
  "date",
  "category",
  "name",
  "value",
  "unit",
  "reference_range",
  "notes",
  "created_at",
  "source",
  "external_id",
  "provider_id",
  "document_id",
  "panel",
  "flag",
  "value_num",
  "canonical_name",
  "edited",
  "loinc",
  "encounter_id",
  "result_status",
  "fasting",
  "specimen",
  "ordering_provider_id",
  "occurred_at",
] as const;

function tableSql(db: Database.Database): string | null {
  return (
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'medical_records'"
        )
        .get() as { sql: string | null } | undefined
    )?.sql ?? null
  );
}

function preserveSequence(
  db: Database.Database,
  prior: number | undefined
): void {
  if (prior == null) return;
  const row = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'medical_records'")
    .get() as { seq: number } | undefined;
  if (row == null) {
    db.prepare(
      "INSERT INTO sqlite_sequence(name, seq) VALUES ('medical_records', ?)"
    ).run(prior);
  } else if (row.seq < prior) {
    db.prepare(
      "UPDATE sqlite_sequence SET seq = ? WHERE name = 'medical_records'"
    ).run(prior);
  }
}

export function up(db: Database.Database): void {
  const sql = tableSql(db);
  if (sql == null || !sql.includes("'biomarker'")) return;

  // The current registry is authoritative evidence. Anything it still cannot answer
  // is made explicitly pending during the table copy rather than forced into a
  // supported class. The old table is NOT NULL, so it cannot represent that final
  // state before the constraint is retired.
  reclassifyLegacyBiomarkerCategory(db);

  const prior = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'medical_records'")
    .get() as { seq: number } | undefined;
  const columns = COLUMNS.join(", ");
  const selectedColumns = COLUMNS.map((column) =>
    column === "category"
      ? "CASE WHEN category = 'biomarker' THEN NULL ELSE category END"
      : column
  ).join(", ");
  db.exec(CREATE);
  db.exec(
    `INSERT INTO medical_records__new_2877 (${columns})
     SELECT ${selectedColumns} FROM medical_records`
  );
  db.exec("DROP TABLE medical_records");
  db.exec("ALTER TABLE medical_records__new_2877 RENAME TO medical_records");
  for (const index of INDEXES) db.exec(index);
  preserveSequence(db, prior?.seq);
}

export const migration: Migration = {
  name: "20260814-medical-category-residue",
  up,
};
