// THE day-counter write ledger (issue #2037) — the EXECUTING half. The discipline, the
// spec type and the declared counters live in lib/day-counter-ledger.ts; this file runs
// the statements that module compiles.
//
// Every operation here is composable INSIDE the caller's `writeTx` and never opens a
// transaction of its own: a counter move is never the whole write (a serving also
// appends a `food_log_events` row, a protein add also records the last-used preset), and
// the counter and the ledger row it stands for must never be observable apart. The
// callers already hold the #468 IMMEDIATE transaction; this is the arithmetic inside it.

import { db } from "./db";
import {
  DAY_COUNTERS,
  dayCounterSql,
  type DayCounterKey,
  type DayCounterSpec,
} from "./day-counter-ledger";

export interface DayCounterLedger {
  readonly spec: DayCounterSpec;
  /**
   * Add `amount` to the (profile, date, key) counter, creating the row when it is the
   * day's first. Returns the AUTHORITATIVE total afterwards — re-selected, never the
   * caller's own arithmetic. `touch` supplies values for `spec.touchColumns`, in order.
   */
  bump(
    profileId: number,
    date: string,
    key: DayCounterKey,
    amount: number,
    touch?: readonly (string | number | null)[]
  ): number;
  /**
   * Subtract `amount`, clamped at zero, and DROP the row once it returns to zero.
   * Returns the authoritative remaining total (0 once the row is gone). Idempotent: an
   * unbump against a coordinate with nothing logged writes nothing and reports 0.
   */
  unbump(
    profileId: number,
    date: string,
    key: DayCounterKey,
    amount: number
  ): number;
  /** The stored total for the coordinate, or 0 when no row exists. */
  total(profileId: number, date: string, key: DayCounterKey): number;
  /**
   * Add `amount` ONLY to an existing row; `false` when there is none. The one arm the
   * undo path needs that `bump` cannot serve: when a delete emptied the day and dropped
   * the row, undo must re-insert the CAPTURED SNAPSHOT (notes and all) rather than a
   * bare counter row, so the caller owns that branch and this reports whether it is
   * needed.
   */
  bumpExisting(
    profileId: number,
    date: string,
    key: DayCounterKey,
    amount: number
  ): boolean;
}

/**
 * Build the ledger for one counter table. Stateless and cheap — the statement text is
 * computed once here and better-sqlite3 caches the prepared statement by that text.
 */
export function dayCounterLedger(spec: DayCounterSpec): DayCounterLedger {
  const sql = dayCounterSql(spec);

  const read = (
    profileId: number,
    date: string,
    key: DayCounterKey
  ): number => {
    const row = db.prepare(sql.select).get(profileId, date, ...key) as
      { amount: number } | undefined;
    return row?.amount ?? 0;
  };

  return {
    spec,
    bump(profileId, date, key, amount, touch = []) {
      db.prepare(sql.upsert).run(profileId, date, ...key, amount, ...touch);
      // The upsert always leaves a row, so this re-read is the authoritative total and
      // its absent-row branch is unreachable by construction.
      return read(profileId, date, key);
    },
    unbump(profileId, date, key, amount) {
      db.prepare(sql.decrement).run(amount, profileId, date, ...key);
      db.prepare(sql.drop).run(profileId, date, ...key);
      return read(profileId, date, key);
    },
    total: read,
    bumpExisting(profileId, date, key, amount) {
      const info = db
        .prepare(sql.incrementExisting)
        .run(amount, profileId, date, ...key);
      return info.changes > 0;
    },
  };
}

export const foodDayCounter = dayCounterLedger(DAY_COUNTERS.food);
export const substanceDayCounter = dayCounterLedger(DAY_COUNTERS.substance);
export const proteinDayCounter = dayCounterLedger(DAY_COUNTERS.protein);
