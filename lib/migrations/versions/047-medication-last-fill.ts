import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 047 (issue #852 item 3): remember the LAST fill size per intake item so
// the one-tap "Refilled" action can increment quantity_on_hand by the amount the user
// last topped up with — without re-asking every time.
//
//   • last_fill_size REAL — the number of units the item was last refilled by (a
//     bottle/pack quantity, e.g. 30 or 90). NULL until the first refill, which is why
//     the first "Refilled" tap asks for the size; every subsequent tap reuses it. It
//     is NOT the on-hand counter (quantity_on_hand) — it's the remembered top-up size.
//
// Nullable/defaulted so every existing supplement/medication row reads exactly as
// before (last_fill_size = NULL). The ADD COLUMN is guarded on PRAGMA table_info so
// the non-version-gated migrate() replay can re-run up() without "duplicate column
// name"; production applies once behind the user_version gate.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "intake_items");
  if (!cols.has("last_fill_size")) {
    db.exec(`ALTER TABLE intake_items ADD COLUMN last_fill_size REAL;`);
  }
}

export const migration: Migration = {
  id: 47,
  name: "047-medication-last-fill",
  up,
};
