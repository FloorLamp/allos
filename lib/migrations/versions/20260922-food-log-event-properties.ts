import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5865 slice 2 — the meal MARK. A property of the meal ("spicy") that no food
// group can carry, stored on the serving's own event row as a JSON array of slugs from
// the closed vocabulary in lib/food-sensitivities.ts (`MEAL_PROPERTIES`). NULL is the
// unmarked serving, which is every row before this and every tap without a chip.
//
// ON THE EVENT ROW, not in a side table, so the tap's Undo (which deletes the row)
// takes the mark with it and the inverse stays complete and local (#2642).

function hasColumn(db: Database.Database, table: string, column: string) {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((row) => row.name === column);
}

export function up(db: Database.Database): void {
  if (!hasColumn(db, "food_log_events", "properties")) {
    db.exec(
      `ALTER TABLE food_log_events ADD COLUMN properties TEXT
         CHECK (properties IS NULL OR json_type(properties) = 'array')`
    );
  }
}

export const migration: Migration = {
  name: "20260922-food-log-event-properties",
  up,
};
