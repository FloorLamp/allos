// DB INTEGRATION TIER — 20260902-imaging-report-narrative: the imported report and
// the impression parsed out of it stop sharing one column (#3594).
//
// THE CLAIM WORTH TESTING IS NOT "THE SCHEMA CHANGED". A migration that added an
// empty `report_narrative` beside a surviving `impression` would satisfy every
// column-set assertion while leaving the falsehood in place, and one that moved
// EVERYTHING would strand the impression a person typed into the impression box. So
// the rows are seeded through the OLD shape and the assertions are about VALUES, on
// both sides of the boundary the migration introduces:
//
//   1. an IMPORTED row's text — a whole rendered report, banner and all — moves to
//      `report_narrative` and `impression` goes NULL: after the fact we cannot tell
//      a report from an impression, and the ruling errs toward claiming less;
//   2. a MANUAL row's text stays in `impression`: its author typed it into the
//      impression box, so there is nothing to guess and the form round-trips;
//   3. NOTHING A PERSON COULD READ IS LOST — every text seeded is still reachable
//      through the read layer's finding accessor, which is the whole point of
//      keeping both rather than parsing at import and dropping the rest;
//   4. replay safety — migrate() is not version-gated, so a second up() is a no-op.
//
// SYNTHETIC ONLY: fictional patient, low-entropy values, deep-past dates.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260902-imaging-report-narrative";
import { studyFindingText } from "@/lib/imaging-study";

const MIGRATION = "20260902-imaging-report-narrative";

// The reported shape: the field holds the banner, the header block and the body, and
// the impression is somewhere inside it.
const WHOLE_REPORT =
  "OBSTETRICS REPORT (Signed Final 10/10/2019) TECHNIQUE: Transabdominal " +
  "ultrasound. IMPRESSION: Normal interval growth at 20 weeks.";
const TYPED_IMPRESSION = "No meniscal tear.";

function beforeSplit(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore(MIGRATION));
  db.prepare("INSERT INTO profiles (id, name) VALUES (1, 'Split Test')").run();
  db.prepare(
    `INSERT INTO medical_documents (id, profile_id, filename, stored_path,
       extraction_status, doc_type)
     VALUES (7, 1, 'export-1.xml', '', 'done', 'ccd')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO imaging_studies
       (id, profile_id, modality, study_date, impression, document_id, source)
     VALUES (?, 1, ?, ?, ?, ?, ?)`
  );
  insert.run(11, "ultrasound", "2019-10-10", WHOLE_REPORT, 7, "document:7");
  insert.run(12, "mri", "2019-11-02", TYPED_IMPRESSION, null, null);
  return db;
}

const rows = (db: Database.Database) =>
  db
    .prepare(
      "SELECT id, impression, report_narrative FROM imaging_studies ORDER BY id"
    )
    .all() as {
    id: number;
    impression: string | null;
    report_narrative: string | null;
  }[];

describe(`${MIGRATION}`, () => {
  it("moves an imported narrative out of impression, leaves a typed one alone, and loses no text", () => {
    const db = beforeSplit();
    runMigrations(db);

    const after = rows(db);
    expect(after).toEqual([
      { id: 11, impression: null, report_narrative: WHOLE_REPORT },
      { id: 12, impression: TYPED_IMPRESSION, report_narrative: null },
    ]);
    // The converse of the move: every seeded text is still what the read layer shows
    // as the study's finding. An over-eager migration passes the assertion above and
    // fails this one.
    expect(after.map(studyFindingText)).toEqual([
      WHOLE_REPORT,
      TYPED_IMPRESSION,
    ]);

    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'imaging_studies'")
      .get();
    expect(() => up(db)).not.toThrow();
    expect(
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'imaging_studies'")
        .get()
    ).toEqual(schema);
    expect(rows(db)).toEqual(after);
  });
});
