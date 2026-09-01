import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// A start-only statement from the expanded form is complete as written. `live`
// distinguishes the one-tap lifecycle row that still expects an end tap.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(practice_logs)").all() as { name: string }[]
    ).map((row) => row.name)
  );
  if (!columns.has("live")) {
    db.exec(
      "ALTER TABLE practice_logs ADD COLUMN live INTEGER NOT NULL DEFAULT 0 CHECK (live IN (0, 1))"
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_practice_logs_profile_live
       ON practice_logs(profile_id, live)
       WHERE live = 1`
  );
}

export const migration: Migration = {
  name: "20260831-live-practice-sessions",
  up,
};
