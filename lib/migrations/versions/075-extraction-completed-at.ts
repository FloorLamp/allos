import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 075 (issue #1022): a completion timestamp for medical-document
// extraction. The morning digest's "new since last digest" documents read
// windowed on `uploaded_at` while eligibility is `extraction_status = 'done'` —
// two different events with no stored timestamp for the second, so a document
// whose extraction completed AFTER the digest cursor passed its upload time was
// permanently invisible to the digest: the 8:50-upload/9:00-digest race, and the
// bigger failed→reprocessed-days-later case.
//
// One nullable ADD COLUMN: `extraction_completed_at TEXT`, stamped with
// datetime('now') by the single writer that transitions a document to 'done'
// (the finalize UPDATE in lib/import-persist.ts persistDocumentImport — every
// extract/import/reprocess path funnels through it), and windowed on by the
// digest's new-documents read instead of `uploaded_at`. NULL for
// pending/processing/failed/skipped rows (they are never digest-eligible).
//
// Existing 'done' rows are backfilled from `uploaded_at` — best-effort ordering
// that keeps the already-extracted history OUT of the next digest window (their
// upload times are behind every live cursor) instead of announcing it all at
// once as "new".
//
// REPLAY SAFETY (the non-version-gated migrate() wrapper used by the DB-tier
// tests): the ADD COLUMN is guarded by a PRAGMA table_info presence check
// (SQLite has no ADD COLUMN IF NOT EXISTS), and the backfill only touches rows
// still NULL, so a replay never overwrites a real completion stamp.
// Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(medical_documents)`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "extraction_completed_at")) {
    db.exec(
      `ALTER TABLE medical_documents ADD COLUMN extraction_completed_at TEXT`
    );
  }
  db.exec(
    `UPDATE medical_documents
        SET extraction_completed_at = uploaded_at
      WHERE extraction_status = 'done' AND extraction_completed_at IS NULL`
  );
}

export const migration: Migration = {
  id: 75,
  name: "075-extraction-completed-at",
  up,
};
