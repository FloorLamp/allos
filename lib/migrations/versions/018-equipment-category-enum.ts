import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 018 (issue #341, parts 2 & 3): make equipment.category a real enum.
//
// The category was TS-only (Barbell | Machine | Other) with NO DB CHECK, and any
// legacy free text was mapped to the fixed set in the UI (EquipmentManager.tsx). This
// migration does three things at once, all in the rebuild copy:
//
//   1. Grows the category set to ONE deliberate expansion (issue #341):
//        strength  — Barbell, Dumbbell, Kettlebell, Machine
//        cardio    — Bike, Shoes
//        recovery  — Sauna, Cold plunge, Red light, Massage device
//        other     — Other
//      matching EQUIPMENT_CATEGORIES in lib/types.ts (parity pinned by
//      lib/__db_tests__/enum-parity.test.ts). NULL stays legal (category unknown).
//   2. Adds the DB CHECK enforcing that set — SQLite can't alter a CHECK in place, so
//      this is the documented rebuild: create-scratch → copy → drop → rename (matching
//      migrations 006/011/015/016).
//   3. Folds every legacy category value INTO the fixed set during the copy (the
//      one-shot data migration the issue calls for), so the DB converges and the UI's
//      free-text → fixed-set mapping can die. A canonical name (case-insensitive) maps
//      to its canonical casing; NULL stays NULL; anything else becomes 'Other' — the
//      same intent the old UI mapping had, now applied once at the source.
//
// equipment is a FK PARENT (exercise_sets.equipment_id REFERENCES equipment(id), from
// migration 006). The runner (and the migrate() test wrapper) apply every migration
// with foreign_keys OFF and restore it after, so dropping and recreating equipment
// does NOT cascade-wipe the referencing sets; ids are preserved in the copy so every
// existing equipment_id link stays valid. equipment has no secondary indexes.
//
// REPLAY SAFETY: the non-version-gated migrate() wrapper replays up() on an already-
// converged DB, so the rebuild is guarded by a sentinel read off the live schema (the
// CHECK listing 'Kettlebell' — a value only the new CHECK introduces); a second run is
// a pure no-op. Production runs it once behind the user_version gate. Determinism rule
// (spec): reads only the DB + its own constants.
//
// The scratch table is named `equipment__new` (ending in `_new`) on purpose: equipment
// DECLARES profile_id, so the profile-scoping owned-table scanner
// (lib/__tests__/profile-scoping.test.ts) would otherwise mistake the transient scratch
// for a new profile-owned table. That scanner skips names ending in `_new`.

function tableSql(db: Database.Database, table: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function up(db: Database.Database): void {
  const sql = tableSql(db, "equipment");
  if (sql === null) return; // absent (partial handle) — nothing to rebuild
  if (sql.includes("'Kettlebell'")) return; // already converged (CHECK present)

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
            'Other'
          )
        ),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        retired INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO equipment__new
        (id, name, weight_kg, category, created_at, profile_id, retired)
        SELECT
          id, name, weight_kg,
          -- Fold any legacy free-text category onto the fixed set so the tighter
          -- CHECK admits every copied row: canonical (case-insensitive) → canonical
          -- casing, NULL → NULL, anything else → 'Other'.
          CASE
            WHEN category IS NULL THEN NULL
            WHEN LOWER(TRIM(category)) = 'barbell' THEN 'Barbell'
            WHEN LOWER(TRIM(category)) = 'dumbbell' THEN 'Dumbbell'
            WHEN LOWER(TRIM(category)) = 'kettlebell' THEN 'Kettlebell'
            WHEN LOWER(TRIM(category)) = 'machine' THEN 'Machine'
            WHEN LOWER(TRIM(category)) = 'bike' THEN 'Bike'
            WHEN LOWER(TRIM(category)) = 'shoes' THEN 'Shoes'
            WHEN LOWER(TRIM(category)) = 'sauna' THEN 'Sauna'
            WHEN LOWER(TRIM(category)) = 'cold plunge' THEN 'Cold plunge'
            WHEN LOWER(TRIM(category)) = 'red light' THEN 'Red light'
            WHEN LOWER(TRIM(category)) = 'massage device' THEN 'Massage device'
            ELSE 'Other'
          END,
          created_at, profile_id, retired
          FROM equipment;
      DROP TABLE equipment;
      ALTER TABLE equipment__new RENAME TO equipment;
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 18,
  name: "018-equipment-category-enum",
  up,
};
