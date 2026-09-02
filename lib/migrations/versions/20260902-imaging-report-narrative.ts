import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// KEEP BOTH (#3594): the imported report narrative and the impression parsed out of
// it are two different facts, and one column was holding whichever the import
// happened to find.
//
// `impression` was written with everything a report offered — a DiagnosticReport's
// conclusion, its coded conclusions AND its whole decoded rendered form; a
// DocumentReference's entire rendered report. That is how a stored "impression" comes
// to begin "OBSTETRICS REPORT (Signed Final 10/10/2024…": the banner, the header
// block and the body, with the impression somewhere inside. A medical record that
// states a finding it did not parse is a record that states a falsehood.
//
// So the narrative keeps its storage under a name that describes it, and `impression`
// is re-added for the parsed finding alone. An imported row's text moves to
// `report_narrative` — we cannot tell after the fact whether it was a whole report or
// a real impression, and the ruling errs toward storing LESS in the parsed field. A
// MANUAL row is different: its author typed the impression into the impression box,
// so it moves back and the form round-trips exactly as before. Every "what did the
// report say" surface reads the impression with the narrative as its fallback, so
// nothing a person could read is lost or hidden.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(imaging_studies)").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (columns.has("report_narrative")) return;
  db.exec(
    `ALTER TABLE imaging_studies RENAME COLUMN impression TO report_narrative;
     ALTER TABLE imaging_studies ADD COLUMN impression TEXT;
     UPDATE imaging_studies
        SET impression = report_narrative, report_narrative = NULL
      WHERE document_id IS NULL AND report_narrative IS NOT NULL`
  );
}

export const migration: Migration = {
  name: "20260902-imaging-report-narrative",
  up,
};
