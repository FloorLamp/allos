import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 150 (issue #2009): notes for the non-food substance day ledger.
// Alcohol already has `food_log.notes`; nicotine and cannabis need the same field
// so the unified history row can expose one storage-agnostic shape. Nullable and
// unbackfilled: existing counts remain valid history entries with no note.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "substance_log").has("notes")) {
    db.exec(`ALTER TABLE substance_log ADD COLUMN notes TEXT`);
  }
}

export const migration: Migration = {
  id: 150,
  name: "150-substance-log-notes",
  up,
};
