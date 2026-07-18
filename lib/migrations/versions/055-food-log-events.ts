import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 055 (issue #950): the food-log EVENT ledger — a per-TAP append-only
// record beside the food_log daily counter, so button ranking can be slot-aware
// ("what does THIS profile eat at THIS time of day"). The medication evolution
// replayed (#797: a daily counter → a per-administration ledger once timing
// mattered) — done BEFORE the naive fix (a window column on the counter, which
// would break the UNIQUE(profile_id, date, group_key) upsert and every SUM reader).
//
// The counter table (food_log) and all its readers stay byte-identical; this table
// is purely additive. One row per serving tap (web one-tap bar OR Telegram button),
// appended in the SAME writeTx that increments the counter (logFoodServingCore).
//   • `date` is the FOOD day (may be yesterday via the backfill toggle) — matches
//     the counter row the tap wrote.
//   • `logged_at` is TAP time (an ISO-8601 UTC instant), NEVER backfilled — decided
//     and load-bearing (#950 §2): ranking predicts the next TAP, so the slot is
//     derived from WHEN the user logs, not when they ate. A future eating-time
//     consumer needs its own capture, not a reinterpretation of this column.
// Slot (morning/midday/evening) is DERIVED at read time from logged_at + the
// profile's timezone + configured slot hours — no stored bucket to go stale on a
// schedule edit. Raw timestamp stored, so a finer-granularity consumer (eating
// windows, protein distribution) reads the same ledger without a migration.
//
// One profile-OWNED table, born `profile_id INTEGER NOT NULL REFERENCES
// profiles(id)` so it joins OWNED_TABLES (lib/owned-tables.ts) — that single edit
// propagates to deleteProfile (the row-ops side-state rule) and the profile-scoping
// leak test. No UNIQUE key: an event ledger is append-only (several taps of the same
// group on the same day are several rows), so undo pops the NEWEST row rather than
// upserting. CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated
// migrate() replay a no-op. Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS food_log_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      group_key  TEXT NOT NULL,
      date       TEXT NOT NULL,
      logged_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_food_log_events_profile
      ON food_log_events(profile_id, logged_at DESC);
    CREATE INDEX IF NOT EXISTS idx_food_log_events_pop
      ON food_log_events(profile_id, date, group_key, logged_at DESC);
  `);
}

export const migration: Migration = {
  id: 55,
  name: "055-food-log-events",
  up,
};
