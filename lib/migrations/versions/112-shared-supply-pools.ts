import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 112 (issue #1374): shared medication/supplement supply pools — the
// household medicine cabinet.
//
// The intake model assumed every bottle belongs to one person: supply is per-item
// (`intake_items.quantity_on_hand`), so a family's shared ibuprofen was either tracked
// on one profile (nobody else's doses decremented it) or duplicated per profile
// (phantom double supply, N low-stock alerts for one bottle).
//
// `shared_supplies` is a household-shared entity, deliberately NOT profile-owned — the
// `providers` registry precedent (a family sees ONE "Quest Diagnostics"; a family owns
// ONE bottle). It therefore carries no `profile_id`, is absent from
// lib/owned-tables.ts, and joins the profile-scoping test's global-tables exemption
// with a justification there. The per-record LINK (`intake_items.supply_id`) lives on a
// profile-owned row and IS covered by the scoping rule through that table.
//
// Column notes:
//   - `quantity_on_hand REAL` — NULL means "not tracking supply" (the same opt-in
//     semantics `intake_items.quantity_on_hand` has). There is deliberately NO
//     `qty_per_dose` on the pool: how many units ONE dose consumes is a property of the
//     taker's item (an adult takes 2 tablets where a child takes 1), so each linked
//     item keeps its own `qty_per_dose` and draws that many units from the pool.
//   - `low_supply_days INTEGER` — the per-pool refill threshold, NULL = the shared
//     DEFAULT_LOW_SUPPLY_DAYS constant. The per-item path has no threshold column at
//     all; the pool gets one because a shared bottle's reorder lead time is a household
//     decision worth recording once.
//   - `strength` / `form` — the free-text bottle identity ("200 mg" / "tablet") so two
//     ibuprofen bottles in one cabinet are distinguishable (#531: label by the attribute
//     that DIFFERS).
//
// FK SHAPE: `intake_items.supply_id` is a brand-new nullable column with a NULL default
// referencing the table created just above, so a plain additive `ADD COLUMN ...
// REFERENCES` yields an enforced FK (the migration 029 / 108 link-integrity
// convention) — nothing can dangle because every existing row is NULL. Deleting a pool
// must null its links first (the row-ops rule); the FK carries no ON DELETE action by
// design, so a cascade can never silently untrack a household's supply.
//
// Replay safety: the table is CREATE ... IF NOT EXISTS, the column sits behind a column
// probe, and the index is CREATE INDEX IF NOT EXISTS, so the non-version-gated
// migrate() replay used by the DB test tier is a pure no-op.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_supplies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      strength TEXT,
      form TEXT,
      quantity_on_hand REAL,
      low_supply_days INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (!columnNames(db, "intake_items").has("supply_id")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN supply_id INTEGER REFERENCES shared_supplies(id);`
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_intake_items_supply
      ON intake_items(supply_id);
  `);
}

export const migration: Migration = {
  id: 112,
  name: "112-shared-supply-pools",
  up,
};
