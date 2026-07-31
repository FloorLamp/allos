import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 120 (issue #1404): the lab RESULT LIFECYCLE — a result's status, the
// correction history a re-issued value used to destroy, and the three collection
// attributes a reading had nowhere to put.
//
// THE CORRECTNESS PART. A source-owned reading is keyed by `external_id` (the
// per-profile partial-unique index from the baseline), and the sync upsert
// (lib/integrations/normalize.upsertVitals) UPDATES that row in place when the
// incoming value differs. Labs genuinely re-issue results — a corrected potassium,
// an amended differential — so that in-place update silently replaced a value the
// user had already read and acted on, with NO record that it ever changed and no
// way to see what it was. FHIR carries exactly this distinction in
// `Observation.status` (preliminary / final / corrected / amended); we dropped it.
//
// Two pieces, deliberately shaped so a reading keeps ONE stable identity:
//
//   • `result_status` on the reading itself — the CURRENT status of the live row.
//     Nullable: every legacy row and every manual entry predates the vocabulary and
//     means "unstated", which is NOT the same claim as 'final'. The CHECK pins the
//     vocabulary without a table rebuild; growing it later needs a rebuild migration.
//
//   • `medical_record_revisions` — the superseded SNAPSHOT of a reading, written
//     just before an ingest overwrites it. The live row is updated IN PLACE (its id
//     is referenced by encounter links, follow-ups, saved items, dismissal keys and
//     the per-row sync provenance ledger, so minting a new row for the correction
//     would strand all of them), and its prior value/unit/range/flag/status is
//     preserved here. A reading that is corrected twice keeps both prior states.
//
// WHY A CHILD TABLE AND NOT AN ARCHIVED medical_records ROW. Keeping the prior value
// as a second `medical_records` row would put a KNOWN-STALE value into every one of
// the ~80 read sites that select from that table — series, dedup, is_latest, counts,
// findings, exports — each of which would have to learn to hide it, and any that
// forgot would show a retracted number as current. A superseded value is provenance,
// not an observation to chart, so it lives beside the reading instead of among the
// readings. This is the same child-table shape as `integration_sync_rows` (#1333).
//
// medical_record_revisions is a CHILD table: it carries NO profile_id and reaches
// one through `record_id` → medical_records, per the profile-scoping test's
// child-table convention (exactly like exercise_sets → activities). It is therefore
// NOT in OWNED_TABLES; deleteProfile clears it explicitly through its parent, and at
// runtime (foreign_keys = ON, see lib/db.ts) ON DELETE CASCADE clears it whenever the
// reading goes away — including the per-document import footprint sweep, which
// deletes a document's medical_records rows. It has no document_id and no source of
// its own for the same reason: it belongs to the reading, so a document delete and a
// document reassign both reach it through the row they already move.
//
// THE ATTRIBUTE PART (additive, no behavior change on its own):
//   • `fasting` — nullable TRI-STATE (1 fasting / 0 non-fasting / NULL unstated). A
//     fasting glucose and a random glucose are read against different bands, and
//     "we don't know" is a real third answer that a 0/1 NOT NULL column would erase.
//   • `specimen` — serum / plasma / whole blood / urine / RBC …, free TEXT because
//     lab menus name specimens far more diversely than any enum we could freeze
//     (and the canonical vocabulary already splits the analytes that matter, e.g.
//     "Folate, RBC" vs "Folate").
//   • `ordering_provider_id` — the clinician who ORDERED the test, distinct from the
//     existing `provider_id`, which lib/types/medical.ts documents as the PERFORMING
//     provider/lab. "Dr. A ordered it, Quest ran it" used to collapse into one link.
//     Same shape as imaging_studies.ordering_provider_id (migration 037): a plain
//     REFERENCES into the shared global providers registry, no ON DELETE (provider
//     merge/delete re-points these links explicitly).
//
// ALTER TABLE ADD COLUMN with a REFERENCES clause is safe here because the added
// column's default is NULL (SQLite's stated requirement when foreign_keys is on).
// Every step is guarded/IF NOT EXISTS, so a migrate() replay is a pure no-op.

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === col);
}

export function up(db: Database.Database): void {
  if (!hasColumn(db, "medical_records", "result_status")) {
    db.exec(
      `ALTER TABLE medical_records
         ADD COLUMN result_status TEXT
         CHECK (result_status IS NULL OR result_status IN ('preliminary','final','corrected','amended'))`
    );
  }
  if (!hasColumn(db, "medical_records", "fasting")) {
    db.exec(
      `ALTER TABLE medical_records
         ADD COLUMN fasting INTEGER
         CHECK (fasting IS NULL OR fasting IN (0, 1))`
    );
  }
  if (!hasColumn(db, "medical_records", "specimen")) {
    db.exec(`ALTER TABLE medical_records ADD COLUMN specimen TEXT`);
  }
  if (!hasColumn(db, "medical_records", "ordering_provider_id")) {
    db.exec(
      `ALTER TABLE medical_records
         ADD COLUMN ordering_provider_id INTEGER REFERENCES providers(id)`
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS medical_record_revisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id       INTEGER NOT NULL REFERENCES medical_records(id) ON DELETE CASCADE,
      -- The reading's prior state, exactly as it stood before the overwrite.
      date            TEXT,
      value           TEXT,
      value_num       REAL,
      unit            TEXT,
      reference_range TEXT,
      flag            TEXT,
      result_status   TEXT,
      -- The status the INCOMING result claimed, when it claimed one ('corrected' /
      -- 'amended'). Kept beside the prior status so a revision row answers both
      -- "what did it say?" and "what replaced it, and did the lab call it a
      -- correction?" without re-reading the live row (which may have moved on again).
      superseded_by_status TEXT,
      -- Who overwrote it: the integration/source string of the ingest that did.
      source          TEXT,
      superseded_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_medical_record_revisions_record
      ON medical_record_revisions(record_id, superseded_at);
  `);
}

export const migration: Migration = {
  id: 120,
  name: "120-lab-result-lifecycle",
  up,
};
