import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Remember whether a taken ledger row changed quantity_on_hand. Normal scheduled and
// PRN logging always consumes supply, so existing rows default to 1. Explicit
// historical entry can opt out when inventory has already been reconciled; recording
// that choice lets later delete/undo operations invert only the writes that actually
// moved supply.
export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(intake_item_logs)`).all() as {
    name: string;
  }[];
  if (!cols.some((column) => column.name === "supply_adjusted")) {
    db.exec(`
      ALTER TABLE intake_item_logs
      ADD COLUMN supply_adjusted INTEGER NOT NULL DEFAULT 1
        CHECK (supply_adjusted IN (0, 1));
    `);
  }
}

export const migration: Migration = {
  id: 80,
  name: "080-intake-log-supply-adjusted",
  up,
};
