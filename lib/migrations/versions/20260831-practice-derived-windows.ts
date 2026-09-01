import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// A user-stated Start/End pair and a window derived from an elapsed duration have
// different DST semantics. Keep that provenance after a live row is closed so
// downstream window readers can prefer the elapsed minutes only for derived rows.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(practice_logs)").all() as { name: string }[]
    ).map((row) => row.name)
  );
  if (!columns.has("derived_window")) {
    db.exec(
      "ALTER TABLE practice_logs ADD COLUMN derived_window INTEGER NOT NULL DEFAULT 0 CHECK (derived_window IN (0, 1))"
    );
  }
  if (!columns.has("correction_locked")) {
    db.exec(
      "ALTER TABLE practice_logs ADD COLUMN correction_locked INTEGER NOT NULL DEFAULT 0 CHECK (correction_locked IN (0, 1))"
    );
  }
}

export const migration: Migration = {
  name: "20260831-practice-derived-windows",
  up,
};
