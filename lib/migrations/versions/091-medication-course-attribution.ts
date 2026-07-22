import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 091 (issues #1204 + #1178): the schema additions that let intake_items
// become the SINGLE medication entity and let a re-prescription attach as a new
// COURSE with its own attribution + dose snapshot.
//
//   medication_courses gains (#1204):
//     - prescriber   TEXT                              — the individual who prescribed
//         this course, as free text (parsed off the source), so the med's history can
//         read "Dr. A · Jan–Mar, Dr. B · Apr–".
//     - provider_id  INTEGER REFERENCES providers(id)  — the resolved individual
//         registry row for that prescriber (exact-match only, like the item's #1051
//         link). No ON DELETE: a provider delete NULLs this back-link first.
//     - dose_snapshot TEXT                             — a descriptive strength + sig
//         SNAPSHOT as prescribed at THIS renewal (Model X, #1204): the live reminder
//         schedule stays item-keyed on intake_item_doses; the course records what was
//         prescribed so a renewal at a new strength is preserved in history.
//
//   (A course is NOT document-keyed: medication_courses has no profile_id and is not an
//   import-footprint table, so binding a document_id would be a footprint blind spot
//   — import-single-entry.test.ts forbids it. A course is cleaned via its parent med's
//   ON DELETE CASCADE, which is #1204's stated cleanup model — a renewal course is
//   cleaned on med delete/merge, not on the contributing document's fate; a reprocess
//   re-derives it, deduped on (item_id, started_on).)
//
//   intake_items gains (#1178):
//     - import_key   TEXT — a STABLE within-document key for an imported medication
//         (`medimport:<document_id>|<lower(name)>`), so a delete-and-reinsert reprocess
//         re-applies an accepted tier-2 visit-link decision to the med (the med has no
//         external_id; its id churns on reprocess, but import_key does not). NULL for a
//         manual med (its stable id suffices). The visit-link decision anchor #1178
//         asks for.
//
// House rules (CLAUDE.md / migration 086 precedent): a NULLABLE `REFERENCES` column
// added via ALTER TABLE ADD COLUMN DOES carry its FK — only ATTACHING an FK to an
// EXISTING column needs a table rebuild. So all of these are plain guarded ADD COLUMNs
// (idempotent for the non-version-gated migrate() replay). The runner applies
// migrations with foreign_keys OFF and restores it, so the stored REFERENCES is
// enforced at runtime on the app's foreign_keys=ON connection.
function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const courseCols = columnNames(db, "medication_courses");
  if (!courseCols.has("prescriber")) {
    db.exec(`ALTER TABLE medication_courses ADD COLUMN prescriber TEXT`);
  }
  if (!courseCols.has("provider_id")) {
    db.exec(
      `ALTER TABLE medication_courses
         ADD COLUMN provider_id INTEGER REFERENCES providers(id)`
    );
  }
  if (!courseCols.has("dose_snapshot")) {
    db.exec(`ALTER TABLE medication_courses ADD COLUMN dose_snapshot TEXT`);
  }

  const itemCols = columnNames(db, "intake_items");
  if (!itemCols.has("import_key")) {
    db.exec(`ALTER TABLE intake_items ADD COLUMN import_key TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_items_import_key
       ON intake_items(profile_id, import_key)`
  );
}

export const migration: Migration = {
  id: 91,
  name: "091-medication-course-attribution",
  up,
};
