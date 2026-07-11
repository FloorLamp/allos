import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 019 (issue #342): generalize the equipment link from the SET level to
// the ACTIVITY level.
//
// `exercise_sets.equipment_id` (baseline / migration 006) models a strength
// IMPLEMENT — "this set used the trap bar." That answers nothing for a ride (one
// bike), a run (one pair of shoes), or a recovery session (one sauna), where the
// gear belongs to the whole SESSION. This adds the session-level link:
//
//   • activities.equipment_id — the piece of gear a whole activity was performed
//     with (Equipment.id), or NULL. Distinct from the set-level implement link,
//     which stays for strength: the two answer different questions (implement-of-set
//     vs gear-of-session), so both live side by side.
//
// FK SHAPE: a REAL FOREIGN KEY, not a bare INTEGER. Unlike the migration-006 case —
// which had to REBUILD tables to attach a FK to a column that ALREADY EXISTED as a
// bare INTEGER (SQLite can't alter a column to add a FK) — this is a BRAND-NEW
// column, and SQLite DOES permit `ADD COLUMN ... REFERENCES` for a newly-added
// column provided it is nullable with a NULL default (both true here). So a plain
// additive ADD COLUMN yields the same enforced FK a rebuild would, without the cost
// and risk of rebuilding the large, FK-parent `activities` table (exercise_sets
// REFERENCES activities). The runner applies migrations with foreign_keys OFF and
// restores it after, so the ADD COLUMN commits cleanly; the stored REFERENCES clause
// is then enforced at runtime on the app's foreign_keys=ON connection (a dangling
// equipment_id write raises "FOREIGN KEY constraint failed", and deleteEquipment
// nulls the link — see lib/equipment.ts).
//
// Additive ADD COLUMN, guarded so the non-version-gated migrate() test wrapper can
// replay the whole list without "duplicate column name"; production runs it once
// behind the user_version gate. Determinism rule (spec): reads only the DB + its own
// constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "activities").has("equipment_id")) {
    db.exec(
      `ALTER TABLE activities ADD COLUMN equipment_id INTEGER REFERENCES equipment(id);`
    );
  }
}

export const migration: Migration = {
  id: 19,
  name: "019-activity-equipment",
  up,
};
