// Read/write layer for stored AI period recaps (issue #20). Mirrors the daily-insights
// persistence (upsert on a natural key, profile-scoped reads) so a recap survives
// across requests and a regenerate
// replaces the prior one for the same anchor. (The lab-trend interpretation kind was
// retired with the Trends → Biomarkers tab — #1164.)

import { db } from "../../db";
import type { PeriodRecap, PeriodRecapKind } from "../../types";
import { RECAP_SCALES } from "../../recap-scale";

// The recap kinds (period-scoped) the Insights tab lists. This is now the whole
// period-recap vocabulary, since the lab-trend kind was removed (#1164).
export const RECAP_KINDS: readonly PeriodRecapKind[] = RECAP_SCALES.map(
  (e) => e.scale
);

export interface SavePeriodRecapInput {
  kind: PeriodRecapKind;
  periodStart: string | null;
  periodEnd: string;
  summary: string;
  model: string | null;
}

// Upsert a period recap for (profile, kind, period_end). Regenerating the same
// anchor overwrites the summary/model in place rather than accumulating rows.
export function savePeriodRecap(
  profileId: number,
  input: SavePeriodRecapInput
) {
  db.prepare(
    `INSERT INTO narratives
       (profile_id, kind, period_start, period_end, summary, model)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, kind, period_end) DO UPDATE SET
       period_start = excluded.period_start,
       summary = excluded.summary,
       model = excluded.model,
       created_at = datetime('now')`
  ).run(
    profileId,
    input.kind,
    input.periodStart,
    input.periodEnd,
    input.summary,
    input.model
  );
}

// The most recent stored period recaps for a profile, newest anchor first. When
// `kinds` is given, only those kinds are returned (e.g. just the period recaps
// for the Insights tab).
export function getRecentPeriodRecaps(
  profileId: number,
  kinds?: readonly PeriodRecapKind[],
  limit = 10
): PeriodRecap[] {
  if (kinds && kinds.length > 0) {
    const placeholders = kinds.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT id, kind, period_start, period_end, summary, model, created_at
           FROM narratives
          WHERE profile_id = ? AND kind IN (${placeholders})
          ORDER BY period_end DESC, id DESC
          LIMIT ?`
      )
      .all(profileId, ...kinds, limit) as PeriodRecap[];
  }
  return db
    .prepare(
      `SELECT id, kind, period_start, period_end, summary, model, created_at
         FROM narratives
        WHERE profile_id = ?
        ORDER BY period_end DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, limit) as PeriodRecap[];
}
