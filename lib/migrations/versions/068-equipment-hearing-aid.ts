import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 068 (issue #713): add 'Hearing aid' to the equipment.category enum.
//
// Hearing aids are the sense-organ trio's DEVICE arm — the #713 ask "hearing aids in
// the Equipment registry (the glasses/device pattern): a device with usage/history, so
// 'which aids, since when' is tracked." The equipment registry already carries exactly
// that shape (name + since/created_at + a `retired` lifecycle + activity links), so a
// hearing aid is ONE new category rather than a parallel devices table — kindOf() maps
// it to the "other" group (it isn't strength/cardio/recovery gear). This mirrors how
// migration 018 first made equipment.category a real enum; the same create→copy→drop→
// rename rebuild is the only way SQLite can grow the CHECK.
//
// PARITY: EQUIPMENT_CATEGORIES (lib/types/training.ts) gains "Hearing aid" in the SAME
// PR, so the DB CHECK ⇔ TS union parity guard (lib/__db_tests__/enum-parity.test.ts)
// stays green. NULL stays a legal category.
//
// equipment is a FK PARENT (exercise_sets.equipment_id REFERENCES equipment(id)). The
// runner (and the migrate() test wrapper) apply every migration with foreign_keys OFF
// and restore it after, so dropping and recreating equipment does NOT cascade-wipe the
// referencing sets; ids are preserved in the copy so every existing equipment_id link
// stays valid.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK listing 'Hearing aid' — a value only THIS migration's CHECK introduces); a
// second run is a pure no-op. Production runs it once behind the user_version gate.
// Determinism (spec): reads only the DB + its own constants.
//
// The scratch table is named `equipment__new` (ending in `_new`) on purpose so the
// profile-scoping owned-table scanner skips the transient scratch (it declares
// profile_id) — the same discipline migration 018 used.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "equipment");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (sql.includes("'Hearing aid'")) return; // already converged (CHECK present)

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE equipment__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        weight_kg REAL,
        category TEXT CHECK (
          category IS NULL OR category IN (
            'Barbell','Dumbbell','Kettlebell','Machine',
            'Bike','Shoes',
            'Sauna','Cold plunge','Red light','Massage device',
            'Hearing aid',
            'Other'
          )
        ),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        retired INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO equipment__new
        (id, name, weight_kg, category, created_at, profile_id, retired)
        SELECT id, name, weight_kg, category, created_at, profile_id, retired
          FROM equipment;
      DROP TABLE equipment;
      ALTER TABLE equipment__new RENAME TO equipment;
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 68,
  name: "068-equipment-hearing-aid",
  up,
};
