import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5865 slice 1 — the DECLARATION a food sensitivity is.
//
// A sensitivity is NOT an allergy and shares nothing with one. `allergies`
// (001-baseline.ts) is FHIR AllergyIntolerance — a clinical, importable record with
// criticality, verification and safety gates that warn on interactions and reorder
// suggestions. A sensitivity gates nothing, warns about nothing, and never reaches the
// passport or the emergency card. Two records that never answer the same question, so
// two tables.
//
// WHAT A ROW SAYS: "after <trigger>, I get <effect>". That is the whole record, and it
// is the FACTOR half of a pair the user authors themselves — the registry's no-miner
// rule (#2572) holds precisely because the app never writes one of these rows.
//
// THE TRIGGER IS TWO COLUMNS, NOT ONE STRING. `trigger_kind` says which vocabulary
// `trigger_slug` is drawn from: a `group` slug is one of the 25 food groups already
// logged against (lib/datasets/data/food-groups.json), and a `property` is a meal
// property from the closed vocabulary in lib/gi-effects.ts. Kept apart because the two
// halves are read by different machinery — a group trigger's factor is the food log the
// app already has, a property trigger's factor is a mark on the meal — and a single
// column would leave every reader guessing which kind of slug it held. The CHECK makes
// a third kind unrepresentable.
//
// NO TEMPORAL COLUMN, DELIBERATELY, and it is not an oversight to correct later. A
// declaration is a STANDING statement, not an event: nothing here reads when it was
// written, the catalog lists it by trigger, and the pair it authorises is computed over
// the FOOD log's own days rather than over this row's age. `status` carries the only
// lifecycle it has — 'stopped' is the Stop-tracking verb, which keeps the row (and any
// past marks it explains) while taking the chip and the pair away.
//
// House rules: NEW profile-OWNED table (born `profile_id INTEGER NOT NULL`), joins
// OWNED_TABLES and the portable export. NOT an import-footprint table — no importer
// writes it and none ever should, since a declaration the person did not make is the
// one thing this model forbids. CREATE ... IF NOT EXISTS keeps the migrate() replay a
// pure no-op.
//
// Determinism: creates a table and one index. Reads nothing, writes no rows.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS food_sensitivities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL REFERENCES profiles(id),
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('group', 'property')),
      trigger_slug TEXT NOT NULL,
      effect       TEXT NOT NULL,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'stopped')),
      UNIQUE (profile_id, trigger_kind, trigger_slug, effect)
    );
    CREATE INDEX IF NOT EXISTS idx_food_sensitivities_profile
      ON food_sensitivities(profile_id, status);
  `);
}

export const migration: Migration = {
  name: "20260912-food-sensitivities",
  up,
};
