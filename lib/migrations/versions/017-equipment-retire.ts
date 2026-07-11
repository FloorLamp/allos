import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 017 (issue #341, part 1): give equipment a lifecycle.
//
// Equipment had no retired state — sold/broken gear could only be DELETED, and the
// delete nulls exercise_sets.equipment_id, erasing "which bar did I PR on" from
// history. This adds the same soft-retire flag intake_item_doses already carries:
//
//   • equipment.retired — 0 (live) / 1 (retired). A retired row is hidden from the
//     pickers and recency-defaulting (getEquipment default) but still labels the
//     historical sets that reference it (getEquipment with includeRetired). Hard
//     delete stays available for genuine mistakes (with its existing null-out).
//
// Additive ADD COLUMN, guarded so the non-version-gated migrate() test wrapper can
// replay the whole list without "duplicate column name"; production runs it once
// behind the user_version gate. Determinism rule (spec): reads only the DB + its
// own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "equipment").has("retired")) {
    db.exec(
      `ALTER TABLE equipment ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;`
    );
  }
}

export const migration: Migration = {
  id: 17,
  name: "017-equipment-retire",
  up,
};
