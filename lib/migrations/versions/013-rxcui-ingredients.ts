import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 013 (issue #279): a nullable `rxcui_ingredients` on intake_items.
//
// The cached `rxcui` (migration 012) is a single PRODUCT-level concept for a
// combination medication (e.g. "Hyzaar" — losartan/hydrochlorothiazide), but the
// interaction datasets key on INGREDIENT-level RxCUIs, so a combo product's code
// never matched a concept and the drug-/food-interaction checkers silently missed
// it. This column caches the confirmed concept's ACTIVE-INGREDIENT RxCUIs (a JSON
// array of code strings, resolved via RxNav `/rxcui/{id}/related?tty=IN` when the
// user confirms a candidate on the item form); both matchers now try every cached
// CUI, so each ingredient matches its concept independently.
//
// OPTIONAL: existing rows stay NULL; an item with no cached ingredients simply
// matches by its product rxcui + name/synonym fallback as before, so no backfill
// is needed (re-confirming the RxNorm code on the edit form populates it).
//
// Additive + replay-safe: the ADD COLUMN is guarded on PRAGMA table_info so the
// non-version-gated migrate() test wrapper (which replays every migration) doesn't
// hit "duplicate column name"; production applies it once behind the user_version
// gate. Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "intake_items").has("rxcui_ingredients")) {
    db.exec(`ALTER TABLE intake_items ADD COLUMN rxcui_ingredients TEXT;`);
  }
}

export const migration: Migration = {
  id: 13,
  name: "013-rxcui-ingredients",
  up,
};
