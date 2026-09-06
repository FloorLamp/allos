import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #3285 item 2 — events link their activities.
//
// `activities.endurance_plan_id` is the link from a logged session to the event it
// was the result of: the race-day run to the marathon, the meet-day lifting session
// to the meet. It is a column ON the activity rather than a join table because an
// activity is the result of at most one event, and an event's result is simply the
// set of activities pointing at it.
//
// FK SHAPE. `REFERENCES endurance_plans(id) ON DELETE SET NULL`: deleting an event
// leaves its activities in place, unlinked — a logged session is training history
// and outlives the plan it happened to be entered for. SQLite permits `ADD COLUMN
// ... REFERENCES` for a new nullable column with a NULL default (migration 019 is
// the precedent), so no rebuild of the large, FK-parent `activities` table. The
// runner applies this with foreign_keys OFF and restores it after; the stored
// action fires on the app's foreign_keys=ON connection. `deleteEndurancePlanCore`
// nulls the links explicitly as well, so its transaction does not depend on the
// pragma.
//
// Replay-safe: the DB tier replays migrations through the non-version-gated
// migrate() wrapper, and SQLite has no ADD COLUMN IF NOT EXISTS.
// Determinism: adds a column and an index. Reads nothing, writes no rows.
export function up(db: Database.Database): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(activities)").all() as { name: string }[]
    ).map((c) => c.name)
  );
  if (!columns.has("endurance_plan_id")) {
    db.exec(
      `ALTER TABLE activities ADD COLUMN endurance_plan_id INTEGER
         REFERENCES endurance_plans(id) ON DELETE SET NULL;`
    );
  }
  // Partial: almost every activity is linked to nothing, and the event page reads
  // by plan id.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_activities_endurance_plan
       ON activities(endurance_plan_id) WHERE endurance_plan_id IS NOT NULL;`
  );
}

export const migration: Migration = {
  name: "20260906-event-activity-link",
  up,
};
