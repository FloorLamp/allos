// Stool ledger reads (issues #2785, #5872). The gather half of lib/bristol-stool.ts,
// which owns every shape decision the panel makes — this resolves the window and the
// rows and hands them over.
//
// Reading `stool_events` since #5872: a stool is an occurrence that MAY carry a type,
// so the row shape below carries `type: number | null` and the readers here differ on
// what they do with the absence.
//
// Nothing here aggregates. The one thing a stool reader must not do is average, and the
// safest way not to do it is not to reach for a daily-total path at all: such a path
// resolves an AVG/SUM per metric and would hand back one number per day. A day with a
// type 2 in the morning and a type 6 at night is two observations, not a 4.
//
// THE PANEL COUNTS TYPED ROWS AND THE RECORD COUNTS EVERY ROW, which is the one place
// the optional type changes an answer. `getBristolReadings` — the panel's gather —
// filters `type IS NOT NULL`, so the distribution and its total are a count of readings
// exactly as they were before the type could be absent: an untyped occurrence names no
// bar and contributes zero to any loose-stool count. `getBristolRows` — the record's —
// returns every row, because "2 today" and the history list count what HAPPENED.
//
// `getBristolDayCount` is here because NEITHER of those answers "how many movements on
// this day": one filters the untyped row out, and the other is windowed, so its length
// is a page size dressed up as a count. The quick-log count line asked the filtering one
// and read two rows over the word "1" (#5872's follow-up).

import { hoistedStatement, today } from "@/lib/db";
import {
  bristolPanelDates,
  buildBristolPanel,
  type BristolPanel,
  type BristolReading,
} from "@/lib/bristol-stool";

const readingsStmt = hoistedStatement(
  `SELECT date, type FROM stool_events
    WHERE profile_id = ? AND type IS NOT NULL AND date >= ? AND date <= ?
    ORDER BY COALESCE(occurred_at, recorded_at) ASC, id ASC`
);

/**
 * Every TYPED stool reading in a closed date window, oldest first — the panel's gather.
 * Profile-scoped. An untyped occurrence is not a reading and is not here.
 */
export function getBristolReadings(
  profileId: number,
  from: string,
  to: string
): BristolReading[] {
  const rows = readingsStmt.all(profileId, from, to) as {
    date: string;
    type: number;
  }[];
  return rows.map((r) => ({ date: r.date, type: r.type }));
}

/**
 * The panel for a profile's trailing window — the per-day strip and the per-type
 * distribution, assembled by the pure builder.
 */
export function getBristolPanel(
  profileId: number,
  todayDate: string = today(profileId)
): BristolPanel {
  const dates = bristolPanelDates(todayDate);
  return buildBristolPanel(
    dates,
    getBristolReadings(profileId, dates[0], dates[dates.length - 1])
  );
}

/** One stored occurrence as the record addresses it: the row, its day, its instants. */
export interface BristolRow {
  /** The `stool_events` row id — the correction's and the delete's whole address. */
  id: number;
  /** Profile-local YYYY-MM-DD. */
  date: string;
  /**
   * 1-7, or NULL for an occurrence nobody saw the form of (#5872). The absence is a
   * state the record renders (`Stool`, with no type sentence), not a row to skip.
   */
  type: number | null;
  /**
   * The three instant columns, SPELLED AS THE SCHEMA SPELLS THEM — the substance
   * ledger page's shape, and for its reason: this row is handed straight to
   * `bestKnownInstant("stool_events", row)`, which resolves the declared column names
   * out of lib/time-columns.ts. Renaming them here would mean a second mapping that
   * the temporal registry cannot see.
   */
  /** The stated movement instant, canonical UTC, or NULL when nobody stated one. */
  occurred_at: string | null;
  /** The tap instant, canonical UTC. Always present — the row was filed at some moment. */
  recorded_at: string;
  /**
   * 'stated' | 'tap' | null, the provenance of `occurred_at`. In practice this
   * ledger yields only 'stated' or null: 'tap' is permitted by the CHECK for
   * vocabulary symmetry with the sibling event ledgers and no stool writer can
   * produce it, which is deliberate and argued at the column in
   * 20260911-stool-events.ts — a reader should not treat it as an unhandled case.
   */
  time_source: string | null;
}

const rowsStmt = hoistedStatement(
  `SELECT id, date, type, occurred_at, recorded_at, time_source
     FROM stool_events
    WHERE profile_id = ? AND date >= ? AND date <= ?
    ORDER BY date DESC, COALESCE(occurred_at, recorded_at) DESC, id DESC
    LIMIT ?`
);

/**
 * The record's occurrences, newest first and bounded — the `/history` shape (#4433).
 *
 * Separate from `getBristolReadings` above rather than a widening of it: that one
 * answers the PANEL's question (typed only, oldest first, whole window, no row
 * identity) and the panel builder is deliberately unable to name a row. This one
 * carries the address a correction and a delete need and every row the person logged,
 * which is the difference the two callers turn on.
 */
export function getBristolRows(
  profileId: number,
  from: string,
  to: string,
  limit: number
): BristolRow[] {
  const rows = rowsStmt.all(profileId, from, to, limit) as BristolRow[];
  return rows;
}

const dayCountStmt = hoistedStatement(
  `SELECT COUNT(*) AS n FROM stool_events WHERE profile_id = ? AND date = ?`
);

/**
 * HOW MANY MOVEMENTS ONE DAY HOLDS — every row, typed or not, and no window.
 *
 * The number the quick-log sheet prints beside the picker, so a second tap is informed
 * rather than accidental, and the same number after a correction or an Undo.
 *
 * COUNTED IN SQL rather than taken off `getBristolRows`, because that reader is bounded
 * (its window is the receipt's work bound, not its answer) and a count must not silently
 * inherit a row cap: a day past the bound would go on reporting the bound. The delete
 * core says the same thing from the other side — this ledger keeps no day counter,
 * the count IS the rows.
 */
export function getBristolDayCount(profileId: number, date: string): number {
  return (dayCountStmt.get(profileId, date) as { n: number }).n;
}
