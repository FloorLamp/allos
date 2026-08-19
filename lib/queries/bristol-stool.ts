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
  const rows = readingsStmt.all(
    profileId,
    BRISTOL_STOOL_METRIC,
    from,
    to
  ) as { date: string; value: number }[];
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
