import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5026 phase 2 (items 2 and 3): NICOTINE, CANNABIS AND EVERY CUSTOM KEY GET
// THE EVENT LEDGER ALCOHOL ALREADY HAD.
//
// A consumable is an EVENT (owner ruling, 2026-09-04, docs/internals/substances.md).
// Alcohol's units were already `food_log_events` rows carrying `occurred_at` +
// `time_source`; every other substance rode `substance_daily_totals` alone, which is
// UNIQUE per (profile, date, substance) and structurally timeless — so a use was a
// number per day rather than a thing that happened. `substance_log_events` is the
// `food_log_events` shape re-instantiated for that ledger, and nothing else: same
// column names, same semantics, same NULL-means-nobody-said rule. The counter row
// stays exactly where it is, as the cap's substrate and the card's count (the food
// pairing, unchanged since #950).
//
// WHAT IS NOT COPIED, and why: `meal_slot` (a food window has no substance meaning)
// and `notify_message_id` (substance is off the chat vocabulary by reach policy —
// `TELEGRAM_DOMAIN_CENSUS`, docs/internals/substances.md), so a substance tap has no
// originating message to point at.
//
// ── THE FATE OF EVERY ROW LOGGED BEFORE THIS CHANGE ──────────────────────────
//
// This is the decision the change turns on, so it is stated rather than left to be
// inferred from the SQL. A day count of 3 is three uses somebody recorded. After this
// migration the record reads the EVENTS, so a day row with no events behind it counts
// on the card and against the weekly cap while showing nothing in the record — a row
// that is real by one reading and absent by another. That state already exists on the
// alcohol side and is item 3 of this issue (#5085 measures it from the other side).
//
// So a counter row's units ARE events, and where the events are missing this migration
// CREATES them. Both ledgers, one rule:
//
//   • `units` rows per `substance_daily_totals` row;
//   • `servings` MINUS the events already there, per alcohol `food_daily_totals` row
//     (item 3 — every shipped counter bump since #950 shares its transaction with an
//     event insert, so a shortfall means the row predates that ledger).
//
// Nothing is dropped and NO EVENT TIME IS INVENTED: `occurred_at` and `time_source`
// are NULL on every derived row, which is the honest answer and an answer this app
// already has a name for (`eventInstant` → `not-recorded`, lib/row-instants.ts). A
// derived use therefore draws no chart tick and prints no stated hour, exactly as the
// day row it came from did.
//
// `recorded_at` IS NOT NULL on both ledgers, so a derived row has to carry one, and it
// takes THE DAY ROW'S OWN filing stamp — `substance_daily_totals.recorded_at` (the
// LAST tap's instant) and `food_daily_totals.created_at` (when the day row entered the
// app). The day row remembers exactly one, so all of a day's derived events share it.
// That is a real stored record instant and it is the only one there is; what it does
// NOT claim is that any use HAPPENED then, because `occurred_at` is where that claim
// would live and it is NULL. The visible consequence, said plainly because a reader
// will meet it: a legacy nicotine day that showed one date-only row now shows one row
// per use, each reading "logged HH:MM" off that shared stamp.
//
// Determinism: reads only the DB and its own constants; every derived value comes from
// a column already stored. No clock, no random, no network.
//
// REPLAY-SAFE. `migrate()` (lib/db.ts) applies every migration unconditionally, so
// both backfills are written as "insert the shortfall": a second run computes a
// shortfall of zero and inserts nothing.

// `food_daily_totals.created_at` is the `bare` convention — `YYYY-MM-DD HH:MM:SS`, UTC,
// unstated (docs/internals/time-columns.md) — while `food_log_events.recorded_at` is
// `canonical`. Converting on the way in is what keeps the new rows readable by
// `parseUtcSql` beside every tap-written one; a bare value copied through would sort
// and parse differently from its neighbours.
const CANONICAL_CREATED_AT = `
  CASE
    WHEN d.created_at LIKE '____-__-__ __:__:__'
      THEN replace(d.created_at, ' ', 'T') || 'Z'
    ELSE d.created_at
  END`;

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS substance_log_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id),
      substance   TEXT NOT NULL,
      date        TEXT NOT NULL,
      -- The tap instant. Canonical by DEFAULT as well as by writer, matching
      -- food_log_events.recorded_at.
      recorded_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      -- The USE instant, nullable: NULL means nobody stated one. time_source records
      -- whether a present value came from a tap contract or from a person saying so --
      -- the same closed pair food_log_events carries.
      occurred_at TEXT,
      time_source TEXT
        CHECK (time_source IS NULL OR time_source IN ('tap', 'stated'))
    );
    CREATE INDEX IF NOT EXISTS idx_substance_log_events_profile
      ON substance_log_events(profile_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_substance_log_events_day
      ON substance_log_events(profile_id, date, substance, recorded_at DESC);
  `);

  // ── The substance ledger's own backfill (item 2) ──────────────────────────
  //
  // One row per outstanding unit. The recursive CTE counts the SHORTFALL between the
  // day's `units` and the events already standing for it, so a replay adds nothing and
  // a day that has since gained real taps is topped up rather than doubled.
  db.exec(`
    WITH shortfall AS (
      SELECT t.id, t.profile_id, t.substance, t.date, t.recorded_at,
             t.units - (
               SELECT COUNT(*) FROM substance_log_events e
                WHERE e.profile_id = t.profile_id
                  AND e.date = t.date
                  AND e.substance = t.substance
             ) AS missing
        FROM substance_daily_totals t
    ),
    expanded(id, profile_id, substance, date, recorded_at, remaining) AS (
      SELECT id, profile_id, substance, date, recorded_at, missing
        FROM shortfall WHERE missing > 0
      UNION ALL
      SELECT id, profile_id, substance, date, recorded_at, remaining - 1
        FROM expanded WHERE remaining > 1
    )
    INSERT INTO substance_log_events
      (profile_id, substance, date, recorded_at, occurred_at, time_source)
    SELECT profile_id, substance, date, recorded_at, NULL, NULL FROM expanded;
  `);

  // ── The orphan alcohol day (item 3) ───────────────────────────────────────
  //
  // The same rule on the other ledger, scoped to the alcohol group because that is the
  // group whose counter and record disagree: the substance card counts it and the
  // weekly cap counts it, and since 2026-09-04 the record reads the events instead.
  // Deliberately NOT widened to every food group — a non-alcohol shortfall is the same
  // shape but a different surface's question, and this issue owns the substance one.
  db.exec(`
    WITH shortfall AS (
      SELECT d.id, d.profile_id, d.date,
             ${CANONICAL_CREATED_AT} AS stamp,
             d.servings - (
               SELECT COUNT(*) FROM food_log_events e
                WHERE e.profile_id = d.profile_id
                  AND e.date = d.date
                  AND e.group_key = 'alcohol'
             ) AS missing
        FROM food_daily_totals d
       WHERE d.group_key = 'alcohol'
    ),
    expanded(profile_id, date, stamp, remaining) AS (
      SELECT profile_id, date, stamp, missing FROM shortfall WHERE missing > 0
      UNION ALL
      SELECT profile_id, date, stamp, remaining - 1
        FROM expanded WHERE remaining > 1
    )
    INSERT INTO food_log_events
      (profile_id, group_key, date, recorded_at, occurred_at, time_source)
    SELECT profile_id, 'alcohol', date, stamp, NULL, NULL FROM expanded;
  `);
}

export const migration: Migration = {
  name: "20260905-substance-event-rows",
  up,
};
