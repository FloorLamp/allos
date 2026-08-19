import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2856 — `intake_item_ingredients`, the label composition of an intake item.
//
// A multi-ingredient blend is ONE intake_items row, and every engine that reasons
// about what is IN an item reads NAME TOKENS ONLY: the UL/stack totals
// (lib/dri.ts NAME_MATCHERS, first match wins), the interaction and allergen belts
// (lib/supplement-safety.ts, lib/drug-interactions.ts) and the fat-timing default
// (lib/intake-schedule.ts). So a "Mood Support" blend containing St. John's Wort
// passed the SSRI interaction check silently, and an "Eye Health+" capsule's zinc
// and copper were invisible to their upper-limit checks even when the amounts were
// sitting in the item's free-text notes.
//
// This is the supplement-shaped, AMOUNT-CARRYING twin of the medication side's
// cached `rxcui_ingredients` (#279): one row per label ingredient, consulted by the
// same matchers the item name already goes through.
//
// COLUMNS.
//   name        — the ingredient as the label states it ("Zinc (as zinc bisglycinate)").
//                 The matchers tokenize it; nothing here is a controlled vocabulary.
//   amount_text — the label text for the amount, EXACTLY as entered ("11 mg", "2 g",
//                 "1000 IU"). Preserved because it is what the bottle says and the
//                 only thing the user can check the app's arithmetic against.
//   amount/unit — the canonical reading of amount_text, per SINGLE DOSE UNIT (one
//                 capsule/tablet/scoop). NULL when the text carries no parseable
//                 quantity ("proprietary blend"), which is a real label shape and
//                 must not become a fabricated zero.
//
// WHY `unit` ALLOWS 'iu'. mg/mcg are canonical mass and are converted at the write
// boundary (g -> mg). International Units are NOT convertible to mass without
// knowing WHICH nutrient is being measured — 1 IU of vitamin D is 0.025 mcg and 1 IU
// of vitamin E is not — so converting here would require this table to resolve
// nutrient identity, which is the matchers' job, not the schema's. The IU value is
// therefore stored as stated and converted per-nutrient downstream by the SAME
// dri.toNutrientUnit the dose-amount path already uses. One conversion, one place.
//
// NO TEMPORAL COLUMNS, deliberately. An ingredient row is an ATTRIBUTE of the item,
// not an event: the set is replaced wholesale each time the user saves the form (the
// intake_item_pairs posture), so a per-row created_at would record when a save
// happened, never when anything about the person's health did. The item's own
// created_at remains the record stamp. Nothing to declare in lib/time-columns.ts.
//
// CASCADE. item_id cascades: composition cannot outlive the item it describes. The
// reverse-lookup index keeps the cascade (and every per-item read) off a table scan.
//
// Additive and replay-safe (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
// EXISTS), so the non-version-gated migrate() test wrapper can replay it.
// Determinism: reads only the DB, writes no rows — existing items simply have no
// composition until someone enters one (#798: nothing writes without a user action).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intake_item_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES intake_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount_text TEXT,
      amount REAL CHECK (amount IS NULL OR amount >= 0),
      unit TEXT CHECK (unit IS NULL OR unit IN ('mg','mcg','iu')),
      sort INTEGER NOT NULL DEFAULT 0,
      CHECK ((amount IS NULL) = (unit IS NULL))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_intake_item_ingredients_item
       ON intake_item_ingredients(item_id, sort)`
  );
}

export const migration: Migration = {
  name: "20260819-intake-item-ingredients",
  up,
};
