import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2883, wave 2: metric sample windows are instants, not profile-local
// clock values. These are name-only renames: both the vendor ISO-with-milliseconds
// shape and the existing day-midnight anchor stay byte-identical.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(metric_samples)").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (columns.has("start_time")) {
    db.exec(
      "ALTER TABLE metric_samples RENAME COLUMN start_time TO started_at"
    );
  }
  if (columns.has("end_time")) {
    db.exec("ALTER TABLE metric_samples RENAME COLUMN end_time TO ended_at");
  }
}

export const migration: Migration = {
  name: "20260815-metric-sample-instants",
  up,
};
