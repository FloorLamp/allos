import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 043 (issue #798): the per-item PRN redose-notice fields on intake_items.
//
// A PRN (as-needed) medication can carry a "redose notice" — after an administration
// is logged (#797's ledger), notify once when the minimum interval elapses ("6h since
// Ibuprofen — your minimum interval has passed · 2 of 4 today"). Three nullable/
// defaulted columns drive it, all OFF for every existing row:
//
//   • min_interval_hours REAL — the confirmed minimum hours between doses (the OTC
//     label value, PRE-FILLED from the curated lib/prn-defaults dataset but only ever
//     the user's own confirmed number). NULL = unconfirmed ⇒ NO notice, ever (the
//     liability line: the app only states facts about numbers the user confirmed).
//   • max_daily_count INTEGER — the confirmed maximum administrations per day; drives
//     the "N of M today" count and the once-per-day suppression at the max. NULL =
//     unconfirmed ⇒ no notice.
//   • redose_notice INTEGER NOT NULL DEFAULT 0 — the per-item opt-in flag. The notice
//     fires only when redose_notice=1 AND both interval/max are confirmed.
//
// The notice is armed by an administration, one-shot per administration (marker keyed
// by administration id), and DELIBERATELY ignores quiet hours (the 3am fever case) —
// all enforced in the notify tick, not the schema. These columns are inert data.
//
// Nullable/defaulted so every existing supplement/medication row reads exactly as
// before (redose_notice=0 ⇒ no behavior change). Each ADD COLUMN is guarded on
// PRAGMA table_info so the non-version-gated migrate() test wrapper can replay up()
// without hitting "duplicate column name"; production applies once behind the
// user_version gate. Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  const cols = columnNames(db, "intake_items");
  if (!cols.has("min_interval_hours")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN min_interval_hours REAL CHECK (min_interval_hours IS NULL OR min_interval_hours > 0);`
    );
  }
  if (!cols.has("max_daily_count")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN max_daily_count INTEGER CHECK (max_daily_count IS NULL OR max_daily_count > 0);`
    );
  }
  if (!cols.has("redose_notice")) {
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN redose_notice INTEGER NOT NULL DEFAULT 0;`
    );
  }
}

export const migration: Migration = {
  id: 43,
  name: "043-prn-redose",
  up,
};
