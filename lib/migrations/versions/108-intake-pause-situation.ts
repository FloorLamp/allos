import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 108 (issue #1296): the INVERSE situational link on intake_items.
//
// `intake_items.situation_id` (migration 029) turns an item ON while a situation is
// active. This adds its mirror — `pause_situation_id` — the "suppress this item WHILE
// situation X is active" link the real-world cases need (Pre-surgery stops fish oil /
// vitamin E; a fasting day skips with-food doses; "hold this while on antibiotics").
// A single-link shape, exactly like situation_id (an item pauses on ONE situation; a
// multi-situation link table is a future need, not this issue).
//
// FK SHAPE: a brand-new nullable column with a NULL default referencing the EXISTING
// `situations` table, so a plain additive `ADD COLUMN ... REFERENCES` yields an
// enforced FK (the migration 029 / 006 link-integrity convention). The runner applies
// every migration with foreign_keys OFF and restores it after, so a FK-parent table
// can be dropped/recreated without cascade-wiping children; here we only add a column,
// so nothing dangles. A column probe keeps the non-version-gated migrate() replay a
// no-op.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "intake_items").has("pause_situation_id")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN pause_situation_id INTEGER REFERENCES situations(id);`
    );
  }
}

export const migration: Migration = {
  id: 108,
  name: "108-intake-pause-situation",
  up,
};
