import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 004 (issue #135, item 4): a lease timestamp for in-flight document
// extraction so a wedged job can be reaped WITHIN a long-lived process, not only on
// the next reboot.
//
// Background AI extraction flips a `medical_documents` row to `extraction_status =
// 'processing'` and runs fire-and-forget. Boot already resets rows a crash left
// mid-flight (bootTasks), but a process that STAYS UP with a hung extraction (a
// never-resolving API call, a stuck import) leaves the row spinning forever. This
// adds `processing_started_at` — stamped every time a row enters 'processing' — so
// the hourly tick can mark 'failed' any row whose lease has run past a timeout
// (reapStuckExtractions in lib/extraction-reaper.ts). NULL for rows not currently
// processing (and for pre-existing 'processing' rows migrated in before the column
// existed — those are still covered by the boot reset).
//
// Guarded ADD COLUMN so a replay of the whole migration list (the non-version-gated
// migrate() test wrapper) doesn't hit "duplicate column name"; production applies it
// exactly once behind the user_version gate. Determinism rule (spec): reads only the
// DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "medical_documents").has("processing_started_at")) {
    db.exec(
      `ALTER TABLE medical_documents ADD COLUMN processing_started_at TEXT;`
    );
  }
}

export const migration: Migration = {
  id: 4,
  name: "004-extraction-lease",
  up,
};
