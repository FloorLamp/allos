import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 025 (issue #344): connect a protocol to the RECOVERY GEAR it studies
// and to the PRACTICE it tracks adherence for — composing what already exists
// rather than growing a new tracking system.
//
//   • protocols.equipment_id — optional reference to the equipment row the
//     protocol is about ("which sauna"), Equipment.id or NULL. A real FK (added
//     to a brand-new nullable column, same shape as migration 019 for
//     activities.equipment_id — SQLite permits `ADD COLUMN ... REFERENCES` for a
//     new nullable column with a NULL default). deleteEquipment nulls it in code
//     (the columns carry no ON DELETE action — the row-ops null-out rule).
//
//   • protocols.frequency_target_id — optional reference to the frequency_targets
//     row that measures the protocol's practice ("sauna 4×/week"), or NULL.
//     Adherence is then the SAME weekly-count computation the Weekly routine
//     widget uses (getFrequencyTargetProgress) — one question, one computation, no
//     parallel adherence engine.
//
//   • protocols.owns_frequency_target — 0/1. The explicit create-vs-reference
//     decision (row-ops rule): 1 when the protocol CREATED its frequency target
//     (so deleting the protocol cleans it up, unless a sibling protocol now
//     references it), 0 when it merely points at a pre-existing routine target it
//     must not destroy.
//
// Additive ADD COLUMNs, each guarded so the non-version-gated migrate() test
// wrapper can replay the whole list without "duplicate column name"; production
// runs each once behind the user_version gate. The runner applies migrations with
// foreign_keys OFF and restores it after, so the stored REFERENCES clauses are
// enforced at runtime on the app's foreign_keys=ON connection. Deterministic —
// reads only the DB + its own constants.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "protocols");
  if (!cols.has("equipment_id")) {
    db.exec(
      `ALTER TABLE protocols ADD COLUMN equipment_id INTEGER REFERENCES equipment(id);`
    );
  }
  if (!cols.has("frequency_target_id")) {
    db.exec(
      `ALTER TABLE protocols ADD COLUMN frequency_target_id INTEGER REFERENCES frequency_targets(id);`
    );
  }
  if (!cols.has("owns_frequency_target")) {
    db.exec(
      `ALTER TABLE protocols ADD COLUMN owns_frequency_target INTEGER NOT NULL DEFAULT 0;`
    );
  }
}

export const migration: Migration = {
  id: 25,
  name: "025-protocol-equipment-practice",
  up,
};
