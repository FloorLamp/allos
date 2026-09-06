import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5304 (ruling on #5077) — A NOTE BELONGS ON THE USE, not on the day that rolls
// uses up. Both event ledgers gain `notes`, and every note already stored on a day row
// (`substance_daily_totals.notes`, `food_daily_totals.notes`) moves onto ONE event of
// that day. Both ledgers, one rule, in the owner's two clauses (#5077, 2026-09-05):
//
//   • a day's note attaches to that day's FIRST derived event, ONCE — never
//     duplicated across the day's uses;
//   • a day with a note and no derivable use gets ONE timeless event carrying it.
//
// "FIRST DERIVED" IS `logged_via IS NULL` FIRST, THEN THE EARLIEST ROW. The ruling's
// predicate is the sort key, not a filter: 20260905-substance-event-rows wrote NULL on
// every row it derived and every production writer takes `loggedVia` with no default,
// so on the substance ledger NULL is "derived" exactly as the ruling says. On the food
// ledger it is not only that — `logged_via` arrived nullable with no backfill
// (20260822), so a serving tapped before that date reads NULL and is a real tap. A
// noted day whose taps ALL carry provenance still has a note and still has a use to
// carry it, and filtering on the predicate would skip that day and mint a phantom
// event beside real ones instead — the note-losing shape the ruling exists to prevent.
// So: prefer a derived row, else the earliest (`recorded_at`, then `id`, the ledgers'
// own order), and mint only for a day with NO event on its coordinate.
//
// THE MINTED EVENT IS THE NOTE'S LAST RESORT: one row for one day. `recorded_at` takes
// the day row's own filing stamp (the substance counter's `recorded_at`; the food
// counter's `created_at`, restated from its bare `YYYY-MM-DD HH:MM:SS` into the
// ledger's canonical spelling as the sibling migration does); `occurred_at`,
// `time_source` and `meal_slot` stay NULL, which is what timeless means — nobody stated
// an hour and nothing invents one. `logged_via` stays NULL for the same reason: the
// surface is genuinely unknown.
//
// THE DAY COLUMNS ARE LEFT STANDING AND UNCLEARED. This migration COPIES. The day note
// stops being collected and displayed in the same change, so a copy costs nothing and
// is the only state in which no note can be lost by a landing order.
//
// Determinism: reads and writes only rows already in the DB. The ALTERs are guarded by
// PRAGMA; `attachNotes` is a no-op on replay (`notes IS NULL` on the target, and the
// mint is guarded by NOT EXISTS), and is exported so a test can RUN the replay rather
// than assert it past an ALTER that throws first (#5290's F4 lesson).

const CANONICAL_CREATED_AT = `
  CASE
    WHEN d.created_at LIKE '____-__-__ __:__:__'
      THEN replace(d.created_at, ' ', 'T') || 'Z'
    ELSE d.created_at
  END`;

function hasColumn(db: Database.Database, table: string, column: string) {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((row) => row.name === column);
}

// One ledger's pairing: the counter table, the event table, and the column that
// names the substance/group on each. The SQL below is written once over this shape.
interface Ledger {
  days: string;
  events: string;
  key: string;
  /** The day row's filing stamp, spelled canonically for the event's `recorded_at`. */
  stamp: string;
}

const LEDGERS: readonly Ledger[] = [
  {
    days: "substance_daily_totals",
    events: "substance_log_events",
    key: "substance",
    stamp: "d.recorded_at",
  },
  {
    days: "food_daily_totals",
    events: "food_log_events",
    key: "group_key",
    stamp: CANONICAL_CREATED_AT,
  },
];

export function attachNotes(db: Database.Database): void {
  for (const { days, events, key, stamp } of LEDGERS) {
    // Each noted day's chosen event, when it has one. The id set is built FROM the
    // noted days — one id per day, never one per use — so "once, never duplicated" is
    // structural rather than a rule to remember.
    db.exec(`
      UPDATE ${events}
         SET notes = (
               SELECT d.notes FROM ${days} AS d
                WHERE d.profile_id = ${events}.profile_id
                  AND d.date       = ${events}.date
                  AND d.${key}     = ${events}.${key}
             )
       WHERE notes IS NULL
         AND id IN (
               SELECT (
                        SELECT e.id FROM ${events} AS e
                         WHERE e.profile_id = d.profile_id
                           AND e.date       = d.date
                           AND e.${key}     = d.${key}
                         ORDER BY (e.logged_via IS NULL) DESC, e.recorded_at, e.id
                         LIMIT 1
                      )
                 FROM ${days} AS d
                WHERE d.notes IS NOT NULL
             )
    `);
    db.exec(`
      INSERT INTO ${events} (profile_id, ${key}, date, recorded_at, notes)
      SELECT d.profile_id, d.${key}, d.date, ${stamp}, d.notes
        FROM ${days} AS d
       WHERE d.notes IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM ${events} AS e
                WHERE e.profile_id = d.profile_id
                  AND e.date       = d.date
                  AND e.${key}     = d.${key}
             )
    `);
  }
}

export function up(db: Database.Database): void {
  for (const { events } of LEDGERS)
    if (!hasColumn(db, events, "notes"))
      db.exec(`ALTER TABLE ${events} ADD COLUMN notes TEXT`);
  attachNotes(db);
}

export const migration: Migration = {
  name: "20260905-event-notes",
  up,
};
