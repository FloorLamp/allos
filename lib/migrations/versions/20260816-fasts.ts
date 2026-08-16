import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #2756 — the fasting lifecycle's one table.
//
// WHY A TABLE AT ALL. A fast cannot be derived from the food log. `food_log_events`
// carries a day attribution and a TAP instant, and the time-model doctrine names this
// exact trap: inferring eating times from tap times turns a distribution of eating
// times into one of tapping times. So a fast is an EXPLICIT claim the user starts and
// ends — no passive detection, ever — and the claim needs somewhere to live.
//
// TWO INSTANTS, NOT TWO DAYS. A fast spans a profile-local day boundary by nature (a
// 16:8 window ends the morning after it started), so a day-grained column would be
// wrong on the majority of rows. Both columns are absolute instants on the CANONICAL
// convention (`YYYY-MM-DDTHH:MM:SSZ`, lib/date.ts's `utcInstant`) and are BORN on it:
// the table is new, so the claim cannot be false, and the entry in
// CANONICAL_INSTANT_COLUMNS (lib/__tests__/instant-writer-scan.test.ts) is what binds
// the FIRST writer to bind utcInstant()/instantNow() rather than choosing a
// serialization at the call site. Day ATTRIBUTION (#94) is derived at read time from
// `ended_at` and the profile timezone — a completed fast counts for the day it ENDS —
// and is deliberately not stored: storing it would freeze one timezone's answer.
//
// NO COLUMN DEFAULTS on either instant, deliberately. SQLite's own `datetime('now')`
// writes the BARE shape (`YYYY-MM-DD HH:MM:SS`), and a bare value in a column readers
// compare against a canonical one sorts wrong while the query still looks right — 'T'
// (0x54) sorts after ' ' (0x20), so every canonical value reads as newer than every
// bare one on the same day. `created_at` beside them is the ordinary bookkeeping stamp
// and stays on the schema's bare convention like every other one.
//
// `ended_at IS NULL` IS THE ACTIVE STATE. There is no status enum: a fast is active
// exactly while it has no end, which is the same open/closed shape `cycles` and
// `illness_episodes` already use. The partial unique index is what makes "one active
// fast per profile" a SCHEMA fact rather than a convention — the write core
// (lib/fast-write.ts) enforces it in the same `writeTx` that reads it, and this index
// is the backstop that survives a core someone forgets to route through.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // One ACTIVE fast per profile. A partial index over the profile alone, restricted to
  // open rows: completed fasts are unconstrained (a profile has many), and the
  // constraint that matters — you cannot be fasting twice at once — is expressed
  // exactly, including the cross-device double-start the core reports as `already-active`.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_fasts_one_active
       ON fasts(profile_id) WHERE ended_at IS NULL`
  );
  // The history read: a profile's fasts newest-first, and the overlap check's scan.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_fasts_profile_started
       ON fasts(profile_id, started_at)`
  );
}

export const migration: Migration = {
  name: "20260816-fasts",
  up,
};
