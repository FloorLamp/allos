import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// #3480 — `intake_items.source_name`: the name the SOURCE DOCUMENT gave this item,
// kept on the record when the person replaced it with a standardized one.
//
// A portal-imported medication lands under the document's own label ("Calcium
// Carb-Cholecalciferol (CALCIUM 500 + D OR)"). The import review page now OFFERS the
// RxNorm preferred name for that string, and accepting it renames the item. The
// portal string is not noise — it is what the pharmacy, the label and the printed
// med list all say, and it is how somebody recognizes the row as their own — so it
// moves onto the record instead of being overwritten. It renders as source detail
// under the medication's name, never as the headline (lib/imported-name.ts).
//
// NULL — which is every existing row, and stays the answer for almost all of them —
// means "the stored name is the one that came in, or the one that was typed". The
// column is written by exactly one path (the adopt action) and is never a second
// place a display name could come from: nothing reads it to build a heading.
//
// No back-fill. Back-filling it would state that every imported row's name had been
// replaced, which is false; and there is no second source for the original name
// after the fact anyway. Existing items are untouched unless the person renames
// them — the issue's own acceptance criterion.
//
// Determinism: schema only.
export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE intake_items ADD COLUMN source_name TEXT;`);
}

export const migration: Migration = {
  name: "20260822-intake-source-name",
  up,
};
