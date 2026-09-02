import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #4435 — `substance_daily_totals` joins the #3087 provenance tranche.
//
// It was left out of the first tranche with a stated reason: "its alcohol twin rides
// the stamped food_log_events rows". True of alcohol, and false of everything else on
// this table — nicotine, cannabis and every substance a profile names itself have no
// event ledger at all, so a nicotine tap was the one user write in the app that could
// not say which surface it came from. #4249's read model reads this column.
//
// SAME SHAPE AS 20260822's, deliberately: plain TEXT, nullable, no default, no CHECK,
// no backfill. Every pre-existing row reads NULL, which means "unknown", honestly.
// The vocabulary stays closed in TypeScript (lib/logged-via.ts).
//
// WHAT IS DIFFERENT HERE, said plainly because the column's own rule is "written at
// creation and never rewritten": this table is a DAY TOTAL, not an occurrence ledger.
// It already re-stamps `recorded_at` on every tap, so `logged_via` re-stamps beside it
// and names the LAST tap's surface. The rule it is measured against is about
// CORRECTIONS not rewriting provenance, and a second tap is not a correction.
//
// Determinism: adds a column only. Reads nothing, writes no rows.

const TRANCHE = ["substance_daily_totals"] as const;

export function up(db: Database.Database): void {
  for (const table of TRANCHE) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN logged_via TEXT`);
  }
}

export const migration: Migration = {
  name: "20260901-substance-logged-via",
  up,
};
