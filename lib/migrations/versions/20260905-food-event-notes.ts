import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5304 — a note belongs on the USE, not on the day that rolls uses up.
//
// `food_log_events` gains `notes`, and every note already stored on a
// `food_daily_totals` day row moves onto ONE event of that day.
//
// WHY THE NOTE COULD NOT STAY ON THE DAY. A day counter row is DROPPED AT ZERO
// (`lib/day-counter-ledger.ts`'s `drop`), and four shipped paths can empty a day
// without meaning to touch its note: the bar's minus, a correction that re-dates or
// re-groups the day's last serving, a cross-midnight re-stamp, and Data → Manage's
// bulk delete of `food_daily_totals` (an excluded undo root — a bare DELETE with no
// capture). None of them captures the row, so each silently destroys text a person
// typed. On an event the note travels with the row those operations MOVE, and dies
// only with the use it was written about.
//
// WHERE EACH NOTE LANDS, and the two clauses are the owner's, verbatim (#5077's
// 10:15Z ruling, restated in #5304):
//
//   • a day's note attaches to that day's FIRST event, ONCE — never duplicated
//     across the day's uses;
//   • a day with a note and no event at all gets ONE timeless event carrying it.
//
// "FIRST" IS BY `recorded_at`, THEN BY `id`. That is the ledger's own ordering
// (migration 183's `idx_food_log_events_pop`), and the id tie-break makes the choice
// total for the several taps that share a second.
//
// WHY NOT `logged_via IS NULL`, WHICH IS THE PREDICATE THE RULING NAMES. On the
// SUBSTANCE ledger that predicate means "derived", because that table is born with
// its rows and only its own migration writes NULL. It does not mean that here.
// `food_log_events` predates provenance: 20260822-logged-via-provenance added
// `logged_via` NULLABLE WITH NO BACKFILL, so every serving tapped before 2026-08-22
// reads NULL and is a REAL TAP. And no migration has ever derived a `food_log_events`
// row from a counter — alcohol's day rows were never materialized, they were written
// as taps through `logFoodServingCore` all along (#4435). So on this ledger there is
// no derived population to find: "the day's first derived event" and "the day's first
// event" name the same row wherever a derived one could exist, and only the second is
// true of a legacy tap. Using the ruling's predicate literally would skip every day
// whose taps all carry provenance and mint a phantom event beside them instead —
// which is the note-losing shape the ruling exists to prevent, wearing the ruling's
// own words.
//
// THE MINTED EVENT IS THE NOTE'S LAST RESORT, and it is one row for one day, not one
// per serving. It is reachable only for a `food_daily_totals` row that carries a note
// and has no event on its (profile, date, group_key) — i.e. a day logged before the
// event ledger existed (migration 056). `recorded_at` takes the day row's OWN
// `created_at`, which is a real record instant rather than a claim about when anybody
// ate; `occurred_at`, `time_source` and `meal_slot` stay NULL, which is what timeless
// means here — nobody stated an hour and nothing invents one. `logged_via` stays NULL
// for the same reason the 20260822 column does: the surface is genuinely unknown.
//
// THE DAY'S OWN `notes` COLUMN IS LEFT STANDING AND UNCLEARED. This migration COPIES;
// it destroys nothing. The day note stops being collected and displayed in the
// change that retires it, and until then a copy is the only state in which no note
// can be lost by a landing order.
//
// Determinism: adds one column, then reads and writes only rows already in the DB.
// Re-running is safe — the ALTER is guarded by PRAGMA, and the backfill skips any day
// whose chosen event already carries a note.

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((row) => row.name === column);
}

// The attachment half, split out so a replay can be RUN rather than asserted by the
// ALTER throwing ahead of it (the #5290 F4 lesson: an idempotence claim proved by a
// statement that never executes twice is not a claim about the backfill at all).
export function attachNotes(db: Database.Database): void {
  // Each noted day's FIRST event, when it has one. The id set is built FROM the noted
  // days — one id per day, never one per serving — so the "once, never duplicated
  // across the day's uses" clause is structural rather than a rule to remember.
  // `notes IS NULL` on the target keeps a replay a no-op and never overwrites a note
  // somebody has since typed on the row.
  db.exec(`
    UPDATE food_log_events
       SET notes = (
             SELECT d.notes FROM food_daily_totals AS d
              WHERE d.profile_id = food_log_events.profile_id
                AND d.date       = food_log_events.date
                AND d.group_key  = food_log_events.group_key
           )
     WHERE notes IS NULL
       AND id IN (
             SELECT (
                      SELECT f.id FROM food_log_events AS f
                       WHERE f.profile_id = d.profile_id
                         AND f.date       = d.date
                         AND f.group_key  = d.group_key
                       ORDER BY f.recorded_at, f.id
                       LIMIT 1
                    )
               FROM food_daily_totals AS d
              WHERE d.notes IS NOT NULL
           )
  `);

  // A noted day with NO event on its coordinate gets exactly one, carrying the note.
  // `recorded_at` is NOT NULL and canonical (#183): the day row's own `created_at` is
  // written by `datetime('now')`, i.e. "YYYY-MM-DD HH:MM:SS", so it is restated in the
  // ledger's spelling. A `created_at` strftime cannot parse leaves the day's own
  // midnight, which is the honest floor for a row whose only instant is its date.
  db.exec(`
    INSERT INTO food_log_events
      (profile_id, group_key, date, recorded_at, notes)
    SELECT d.profile_id, d.group_key, d.date,
           COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', d.created_at),
                    d.date || 'T00:00:00Z'),
           d.notes
      FROM food_daily_totals AS d
     WHERE d.notes IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM food_log_events AS e
              WHERE e.profile_id = d.profile_id
                AND e.date       = d.date
                AND e.group_key  = d.group_key
           )
  `);
}

export function up(db: Database.Database): void {
  if (!hasColumn(db, "food_log_events", "notes"))
    db.exec(`ALTER TABLE food_log_events ADD COLUMN notes TEXT`);
  attachNotes(db);
}

export const migration: Migration = {
  name: "20260905-food-event-notes",
  up,
};
