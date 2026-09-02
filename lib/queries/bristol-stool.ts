// Bristol stool-form reads (issue #2785). The gather half of lib/bristol-stool.ts,
// which owns every shape decision the panel makes — this resolves the window and the
// rows and hands them over.
//
// Nothing here aggregates. The one thing a Bristol reader must not do is average, and
// the safest way not to do it is not to reach for `getMetricDailyTotals` at all: that
// path resolves an AVG/SUM per metric and would hand back one number per day. A day
// with a type 2 in the morning and a type 6 at night is two observations, not a 4.

import { hoistedStatement, today } from "@/lib/db";
import {
  BRISTOL_STOOL_METRIC,
  bristolPanelDates,
  buildBristolPanel,
  type BristolPanel,
  type BristolReading,
} from "@/lib/bristol-stool";

const readingsStmt = hoistedStatement(
  `SELECT date, value FROM metric_samples
    WHERE profile_id = ? AND metric = ? AND date >= ? AND date <= ?
    ORDER BY started_at ASC`
);

/**
 * Every Bristol reading in a closed date window, oldest first. Profile-scoped, and
 * scoped by the metric key so no other sample can reach a Bristol surface.
 */
export function getBristolReadings(
  profileId: number,
  from: string,
  to: string
): BristolReading[] {
  const rows = readingsStmt.all(profileId, BRISTOL_STOOL_METRIC, from, to) as {
    date: string;
    value: number;
  }[];
  return rows.map((r) => ({ date: r.date, type: r.value }));
}

/**
 * The panel for a profile's trailing window — the per-day strip and the per-type
 * distribution, assembled by the pure builder.
 */
export function getBristolPanel(
  profileId: number,
  todayDate = today(profileId)
): BristolPanel {
  const dates = bristolPanelDates(todayDate);
  return buildBristolPanel(
    dates,
    getBristolReadings(profileId, dates[0], dates[dates.length - 1])
  );
}

/** One stored reading as the record addresses it: the row, its day, its wall clock. */
export interface BristolRow extends BristolReading {
  /** The `metric_samples` row id — the correction's and the delete's whole address. */
  id: number;
  /** The observation's profile-local "HH:MM", off `started_at`, which is stored local. */
  hhmm: string;
}

const rowsStmt = hoistedStatement(
  `SELECT id, date, value, substr(started_at, 12, 5) AS hhmm
     FROM metric_samples
    WHERE profile_id = ? AND metric = ? AND date >= ? AND date <= ?
    ORDER BY date DESC, started_at DESC, id DESC
    LIMIT ?`
);

/**
 * The record's readings, newest first and bounded — the `/history` shape (#4433).
 *
 * Separate from `getBristolReadings` above rather than a widening of it: that one
 * answers the PANEL's question (oldest first, whole window, no row identity) and the
 * panel builder is deliberately unable to name a row. This one carries the address a
 * correction and a delete need, which is the difference the two callers turn on.
 */
export function getBristolRows(
  profileId: number,
  from: string,
  to: string,
  limit: number
): BristolRow[] {
  const rows = rowsStmt.all(
    profileId,
    BRISTOL_STOOL_METRIC,
    from,
    to,
    limit
  ) as { id: number; date: string; value: number; hhmm: string }[];
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    type: r.value,
    hhmm: r.hhmm,
  }));
}
