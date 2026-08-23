import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// #3037 — `activity_telemetry.answer`: what the SOURCE said it holds for this
// session. Owner ruling, 2026-08-16 ("store what the source says").
//
// Three states, only two of which the table could express before:
//
//   'streams'  the source handed over second-by-second data
//   'none'     the source answered, and has nothing — a hand-entered or indoor
//              session, or a 404 on /streams for a session with none recorded
//   NULL / no row   never asked, or asked before this column existed
//
// A row-or-no-row could not tell "the source said nothing" from "we wrote an empty
// row for some other reason", so `streams_json = '{}'` carried both meanings and
// the backfill candidate predicate matched a hand-entered session FOREVER: the
// badge could not reach zero, and every user-triggered run spent two requests per
// such session re-learning nothing (~800 against Strava's 1000/day ceiling for a
// profile with 400 of them).
//
// THE BACKFILL OF EXISTING ROWS IS THE SUBTLE PART, and it is deliberately
// asymmetric:
//
//   streams_json non-empty  ->  'streams'. The data is there; that IS the answer.
//   streams_json = '{}'     ->  LEFT NULL, not 'none'.
//
// Before #3034 the sync wrote an empty row on a transient stream failure and on a
// 403 (a token without `activity:read_all` — a CONNECTION fact, not a fact about
// the session). So an existing empty row is NOT evidence the source answered
// "nothing", and classifying them wholesale would abandon sessions that never got
// a fair ask. They stay candidates, get asked once more under the corrected rules,
// and classify themselves. Same discipline #3034 applied to the sync: a persisted
// marker must be stricter than a recomputed verdict.
//
// Reversibility stays deliberate rather than accidental: a session recorded 'none'
// is re-asked when a PERSON chooses to (the "Re-check sessions with no details"
// action), which is exactly the condition lib/integrations/backfill-outcome.ts
// says makes the cost affordable.
//
// Determinism: schema plus a backfill that reads only `streams_json`, which no
// clock or environment touches.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE activity_telemetry ADD COLUMN answer TEXT;

    UPDATE activity_telemetry
       SET answer = 'streams'
     WHERE streams_json IS NOT NULL
       AND TRIM(streams_json) <> ''
       AND TRIM(streams_json) <> '{}';
  `);
}

export const migration: Migration = {
  name: "20260823-telemetry-source-answer",
  up,
};
