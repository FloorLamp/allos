import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3142: a practice session gets a real INTERVAL. `time` is renamed to
// `start_time` — the column always held a start in every writer's intent (the tap
// paths stamp at or after it, the Fitbit importer maps `log.startTime` into it), and
// naming it so is what lets `activityWindow` bound a session at all — and `end_time`
// joins it so a stated window can be drawn.
//
// A RENAME, NOT A REBUILD. Both are name-only: every stored profile-local "HH:MM"
// stays byte-identical, and `end_time` arrives NULL on every existing row, which is
// the honest answer for a session nobody stated an end for. Nothing is backfilled
// from `duration_min` — `activityWindow` derives that end at read time and storing it
// would turn a derivation into a claim.
//
// Guarded on the column set so a second up() over a converted database is a no-op
// (migrate() is not version-gated).
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(practice_logs)").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  if (columns.has("time") && !columns.has("start_time")) {
    db.exec("ALTER TABLE practice_logs RENAME COLUMN time TO start_time");
  }
  if (!columns.has("end_time")) {
    db.exec("ALTER TABLE practice_logs ADD COLUMN end_time TEXT");
  }
}

export const migration: Migration = {
  name: "20260830-practice-session-interval",
  up,
};
