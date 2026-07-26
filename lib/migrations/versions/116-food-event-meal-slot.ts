import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 116: distinguish WHEN a serving was logged from WHICH meal it belongs to.
//
// `logged_at` remains the immutable tap/audit instant used by legacy rows and senders
// that do not choose a meal (for example Telegram). The Food page now permits recent
// backfill, so a tap made today for Monday breakfast must not masquerade as today's
// current window. `meal_slot` stores that explicit Morning/Midday/Evening choice.
//
// Nullable by design: existing events keep deriving their slot from logged_at, so the
// migration needs no lossy backfill and old clients continue to work. New web writes
// provide the explicit slot. The CHECK protects the three-value vocabulary without
// requiring a table rebuild; a future vocabulary change must append a rebuild migration.

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(food_log_events)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "meal_slot")) {
    db.exec(
      `ALTER TABLE food_log_events
       ADD COLUMN meal_slot TEXT
       CHECK (meal_slot IS NULL OR meal_slot IN ('Morning', 'Midday', 'Evening'))`
    );
  }
}

export const migration: Migration = {
  id: 116,
  name: "116-food-event-meal-slot",
  up,
};
