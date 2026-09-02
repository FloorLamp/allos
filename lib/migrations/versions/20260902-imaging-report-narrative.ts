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
// is re-added for the parsed finding alone. A row carrying a `document_id` moves its
// text to `report_narrative` — we cannot tell after the fact whether it was a whole
// report or a real impression, and the ruling errs toward storing LESS in the parsed
// field. A row with NO `document_id` moves back to `impression`, and that is the
// rule as WRITTEN: `document_id IS NULL`, not "a human typed this". It covers the
// study form's own rows, whose author did type into the impression box — and it also
// covers a DOCUMENTLESS (paste) import, which stamps a NULL document_id and a NULL
// source, so its whole-report text stays in `impression` where it already was. That
// preserves the status quo for those rows rather than regressing them; the paste and
// AI paths are a separate, un-split ingest half. Every "what did the report say"
// surface reads the impression with the narrative as its fallback, so nothing a
// person could read is lost or hidden either way.
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
