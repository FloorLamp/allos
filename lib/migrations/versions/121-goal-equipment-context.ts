import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 121 (issue #1610): give an exercise-linked goal an OPTIONAL load
// context — the registry implement its progress is measured on.
//
// Two registry machines both serialize as the exact same logged exercise name
// ("Machine Chest Press"), so `goals.exercise` alone cannot say which stack a 80 kg
// target belongs to. Without this column getGoalProgressMap takes the MAXIMUM across
// every implement, and a light hotel machine's set can advance — or a heavy home
// machine's set can silently complete — a goal set for the other one.
//
// NULLABLE, and NULL is the goal's DEFAULT SCOPE, not a lane: a goal that names no
// implement stays movement-wide and folds every context exactly as it does today,
// which is what every already-stored goal means. (This is deliberately the opposite
// reading from `equipmentLoadLane`, where a NULL set-level equipment_id IS an
// explicit unassigned lane — an OBSERVATION with no implement is a distinct fact,
// while a SCOPE with no implement is simply undeclared. See the goal-lane note in
// lib/goal-progress.ts.) Nothing to backfill: every existing row keeps its current
// behavior by keeping NULL.
//
// NO REBUILD NEEDED. SQLite can't attach a foreign key to an EXISTING column, but it
// DOES allow a NEW nullable REFERENCES column via ALTER TABLE ADD COLUMN (the
// implicit NULL default satisfies the FK trivially) — the posture migrations 104,
// 108 and 111 already ship. The runner applies migrations with foreign_keys OFF and
// restores it afterwards, so the ADD is unconstrained and meets a clean graph.
//
// NO ON DELETE action, matching the equipment link's own convention (#342/#344): the
// write path detaches explicitly. deleteEquipment already NULLs the three existing
// links (exercise_sets, activities, protocols) inside one writeTx and now NULLs this
// one too, so a deleted implement widens its goals back to movement-wide rather than
// stranding a dangling id. `goals` is already profile-owned (no owned-tables.ts
// change — a column is not a table).
//
// Guarded ADD COLUMN + CREATE INDEX IF NOT EXISTS keep a replay a pure no-op.
// Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "goals").has("equipment_id")) {
    db.exec(
      `ALTER TABLE goals ADD COLUMN equipment_id INTEGER REFERENCES equipment(id)`
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_goals_equipment
      ON goals(profile_id, equipment_id);
  `);
}

export const migration: Migration = {
  id: 121,
  name: "121-goal-equipment-context",
  up,
};
