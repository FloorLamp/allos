// The Trends digest's ONE supplemental range gather (#3397).
//
// Practice cadence used to enter the digest through getPracticeTrends, which first
// read the target ledger and then read practice logs. Nutrition and the three logging
// cadences need adjacent stored rows, but adding one reader per ledger would turn a
// compact digest into query fan-out. This union keeps the extension family at ONE
// executed statement. The pure builders in lib/trends-digest-series.ts decide what
// each row means; this module only returns profile-scoped stored facts.

import { db } from "../db";

export type TrendsDigestGatherKind =
  | "practice-target"
  | "source-priority"
  | "practice-log"
  | "macro-tracked"
  | "protein-logged"
  | "food-serving"
  | "dose-log"
  | "weight-log";

export interface TrendsDigestGatherRow {
  kind: TrendsDigestGatherKind;
  key: string | null;
  date: string | null;
  value: number | null;
  aux: string | null;
  source: string | null;
  origin: string | null;
}

// The per-ledger bounds constrain the union's event rows. Each tracked macro/fiber
// metric deliberately keeps getMetricDailyTotals' latest-180-DATES rule before the
// caller applies its display range, so the digest's protein axis is the Nutrition
// chart's axis rather than a second all-time interpretation of the same store.
export function getTrendsDigestGather(
  profileId: number,
  bounds: {
    practiceFrom: string;
    proteinFrom: string;
    foodFrom: string;
    doseFrom: string;
    to: string;
  }
): TrendsDigestGatherRow[] {
  return db
    .prepare(
      `WITH ranked_macro_dates AS (
         SELECT metric, date,
                ROW_NUMBER() OVER (PARTITION BY metric ORDER BY date DESC) AS recency
           FROM (
             SELECT metric, date
               FROM metric_samples
              WHERE profile_id = ?
                AND metric IN ('protein_g', 'carbs_g', 'fat_g', 'fiber_g')
              GROUP BY metric, date
           )
       ), recent_macro_dates AS (
         SELECT metric, date FROM ranked_macro_dates WHERE recency <= 180
       )
       SELECT 'practice-target' AS kind,
              ft.scope_value AS key,
              ft.created_at AS date,
              ft.per_week AS value,
              CAST(ft.per_week_max AS TEXT) AS aux,
              NULL AS source,
              NULL AS origin
         FROM frequency_targets ft
        WHERE ft.profile_id = ? AND ft.scope_kind = 'practice'
          AND (
            NOT EXISTS (
              SELECT 1 FROM protocols owner
               WHERE owner.profile_id = ft.profile_id
                 AND owner.frequency_target_id = ft.id
                 AND owner.owns_frequency_target = 1
            )
            OR EXISTS (
              SELECT 1 FROM protocols live
               WHERE live.profile_id = ft.profile_id
                 AND live.frequency_target_id = ft.id
                 AND live.end_date IS NULL
            )
          )
       UNION ALL
       SELECT 'source-priority', value, NULL, NULL, NULL, NULL, NULL
         FROM profile_settings
        WHERE profile_id = ? AND key = 'metric_source_priority'
       UNION ALL
       SELECT 'practice-log', practice, date, 1, NULL, NULL, NULL
         FROM practice_logs
        WHERE profile_id = ? AND date >= ? AND date <= ?
       UNION ALL
       SELECT 'macro-tracked', ms.metric, ms.date, SUM(ms.value), NULL,
              ms.source, ms.origin
         FROM metric_samples ms
         JOIN recent_macro_dates recent
           ON recent.metric = ms.metric AND recent.date = ms.date
        WHERE ms.profile_id = ?
        GROUP BY ms.metric, ms.date, ms.source, ms.origin
       UNION ALL
       SELECT 'protein-logged', NULL, date, grams, NULL, NULL, NULL
         FROM protein_daily_totals
        WHERE profile_id = ? AND date >= ? AND date <= ? AND grams > 0
       UNION ALL
       SELECT 'food-serving', group_key, date, servings, NULL, NULL, NULL
         FROM food_daily_totals
        WHERE profile_id = ? AND date >= ? AND date <= ? AND servings > 0
       UNION ALL
       SELECT 'dose-log', NULL, l.date, 1, NULL, NULL, NULL
         FROM intake_item_logs l
         JOIN intake_items i ON i.id = l.item_id
       WHERE i.profile_id = ? AND l.date >= ? AND l.date <= ?
          AND l.status = 'taken' AND l.item_id IS NOT NULL
       UNION ALL
       SELECT 'weight-log', NULL, date, 1, NULL, NULL, NULL
         FROM body_metrics
        WHERE profile_id = ? AND date >= ? AND date <= ?
          AND weight_kg IS NOT NULL
        GROUP BY date`
    )
    .all(
      profileId,
      profileId,
      profileId,
      profileId,
      bounds.practiceFrom,
      bounds.to,
      profileId,
      profileId,
      bounds.proteinFrom,
      bounds.to,
      profileId,
      bounds.foodFrom,
      bounds.to,
      profileId,
      bounds.doseFrom,
      bounds.to,
      profileId,
      bounds.practiceFrom,
      bounds.to
    ) as TrendsDigestGatherRow[];
}
