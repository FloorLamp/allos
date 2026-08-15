import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2883, wave 1: this is the immutable instant when the daily total was
// stored. Rename only; SQLite preserves every value, row id, constraint, index,
// and AUTOINCREMENT high-water mark.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(substance_daily_totals)").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (columns.has("logged_at")) {
    db.exec(
      "ALTER TABLE substance_daily_totals RENAME COLUMN logged_at TO recorded_at"
    );
  }
}

export const migration: Migration = {
  name: "20260815-substance-recorded-at",
  up,
};
