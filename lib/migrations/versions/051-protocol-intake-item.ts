import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 051 (issue #660): a direct link from a protocol to the intake ITEM
// (supplement or medication) it studies — the creatine case, the app's own example.
// Until now the only path from a protocol to its intervention supplement was
// INDIRECT (activating a situation that happened to surface a situational item), so
// the intervention was never first-class. This column makes it explicit.
//
//   • protocols.intake_item_id — optional reference to the intake_items row the
//     protocol is about, or NULL. A real FK on a brand-new nullable column (same
//     shape as migration 025's equipment_id/frequency_target_id — SQLite permits
//     `ADD COLUMN ... REFERENCES` for a new nullable column with a NULL default).
//     deleteProfile clears protocols by profile_id; deleting the intake item nulls
//     this link in code (the columns carry no ON DELETE action — the row-ops
//     null-out rule).
//
// Guarded ADD COLUMN so the non-version-gated migrate() test wrapper can replay the
// whole list without "duplicate column name"; production runs it once behind the
// user_version gate. The runner applies migrations with foreign_keys OFF and
// restores it after, so the stored REFERENCES clause is enforced on the app's
// foreign_keys=ON connection. Deterministic — reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "protocols");
  if (!cols.has("intake_item_id")) {
    db.exec(
      `ALTER TABLE protocols ADD COLUMN intake_item_id INTEGER REFERENCES intake_items(id);`
    );
  }
}

export const migration: Migration = {
  id: 51,
  name: "051-protocol-intake-item",
  up,
};
