import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 098 (issue #1078): the dedicated NON-FOOD substance consumption ledger
// — nicotine + cannabis per-use counts behind the substance-use surface's one-tap
// log/undo and the weekly-cap reduction target. The #860/#944 reconciliation is
// recorded in lib/substance-use.ts: alcohol stays on food_log (a standard drink IS
// one serving of the curated `alcohol` food group — do NOT migrate it here), while
// nicotine/cannabis are not foods, and none of the existing observation stores
// carries a per-day tap-count semantic (symptom_logs is severity-per-day,
// metric_samples/body_metrics are measured values, medical_records is
// result-shaped) — so this is the food_log COUNTER shape re-instantiated
// (product-decided in #1078): one row per (profile, date, substance) whose `units`
// count the one-tap bar increments (undo = decrement, dropped at zero), keyed by
// the same UNIQUE upsert. `substance` holds a lib/substance-use.ts Substance key
// whose ledger is 'substance-log' — validated in the write core against the
// catalog (the food_log group_key discipline: no CHECK, so a future substance
// needs no rebuild), so a forged key lands nothing. `logged_at` is the LAST tap
// instant (ISO-8601 UTC; there is deliberately NO per-tap event ledger — #950's
// slot-aware button ranking is a food-bar need that doesn't exist here). `source`
// + `edited` are the owned-table source-hygiene columns (#1078 asks for them so a
// future device importer can join without a migration); today the one-tap actions
// are the ONLY writer (source 'user'), no keyed import upsert exists, and nothing
// consults the #133 edit lock — wired the day an importer arrives, not before.
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES
// profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts) — that single edit
// propagates to deleteProfile and the profile-scoping leak test — and the
// portable-export DATASETS (export-completeness binds them). CREATE ... IF NOT
// EXISTS + the index guard keep the non-version-gated migrate() replay a no-op.
// Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS substance_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      date       TEXT NOT NULL,
      substance  TEXT NOT NULL,
      units      INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
      logged_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source     TEXT NOT NULL DEFAULT 'user',
      edited     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (profile_id, date, substance)
    );
    CREATE INDEX IF NOT EXISTS idx_substance_log_profile
      ON substance_log(profile_id, date DESC);
  `);
}

export const migration: Migration = {
  id: 98,
  name: "098-substance-log",
  up,
};
