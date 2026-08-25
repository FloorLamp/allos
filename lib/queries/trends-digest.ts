// The Trends digest's batched gather for supplemental logging facts (#3397/#3723).
//
// Practice cadence and macro nutrition are deliberately absent: the cadence ledger
// and getMacroFiberDays already own those questions. This query batches only the
// three logging ledgers plus the food-group rows that have no shared range reader.

import { db } from "../db";

export type TrendsDigestGatherKind = "food-serving" | "dose-log" | "weight-log";

export interface TrendsDigestGatherRow {
  kind: TrendsDigestGatherKind;
  key: string | null;
  date: string | null;
  value: number | null;
}

export function getTrendsDigestGather(
  profileId: number,
  bounds: {
    from: string;
    to: string;
  }
): TrendsDigestGatherRow[] {
  return db
    .prepare(
      `SELECT 'food-serving' AS kind, group_key AS key, date, servings AS value
         FROM food_daily_totals
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0
       UNION ALL
       SELECT 'dose-log', NULL, l.date, 1
         FROM intake_item_logs l
         JOIN intake_items i ON i.id = l.item_id
       WHERE i.profile_id = ? AND l.date >= ? AND l.date <= ?
          AND l.status = 'taken' AND l.item_id IS NOT NULL
       UNION ALL
       SELECT 'weight-log', NULL, date, 1
         FROM body_metrics
        WHERE profile_id = ? AND date >= ? AND date <= ?
          AND weight_kg IS NOT NULL
        GROUP BY date`
    )
    .all(
      profileId,
      bounds.from,
      bounds.to,
      profileId,
      bounds.from,
      bounds.to,
      profileId,
      bounds.from,
      bounds.to
    ) as TrendsDigestGatherRow[];
}
