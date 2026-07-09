// The impure (DB-touching) half of an activity merge, shared by the Data → Review
// duplicate resolver (app/(app)/data/review-actions.ts) and the Journal's manual
// pair-merge (app/(app)/journal/actions.ts). The pure fold math lives in
// lib/import-review/detect.ts (foldActivityFields); this writes the folded result
// onto the keeper. Server-only (uses the sync `db`).
//
// Callers own the DELETE of the discarded row and the recorded pair-decision — the
// two merges differ there: the review resolver deletes via FK cascade (no undo),
// while the journal's manual merge routes the delete through captureDelete so a
// mis-merge can be undone from a toast (issue #64 / #30).

import { db } from "./db";
import { foldActivityFields } from "./import-review/detect";

// Fold the DISCARDED row's gap-filling fields into the KEEPER — COALESCE(keep, drop)
// per column, so the keeper's own values always win and the discarded row only fills
// a gap — and mark the keeper `edited = 1` so a later re-ingest of the rolling window
// won't clobber the merged result (the user-edit-wins lock, same convention
// saveActivity uses). PROFILE-SCOPED (the UPDATE filters profile_id); the caller has
// already verified both rows are the acting profile's. `keep`/`drop` are the full
// activity rows the caller SELECTed.
export function writeActivityFold(
  profileId: number,
  keepId: number,
  keep: Record<string, unknown>,
  drop: Record<string, unknown>
): void {
  const f = foldActivityFields(keep, drop);
  db.prepare(
    `UPDATE activities
        SET notes = ?, duration_min = ?, distance_km = ?, intensity = ?,
            start_time = ?, end_time = ?, components = ?,
            avg_hr = ?, max_hr = ?, elevation_m = ?, avg_speed_kmh = ?,
            max_speed_kmh = ?, relative_effort = ?, avg_power_w = ?,
            max_power_w = ?, weighted_avg_power_w = ?, avg_cadence = ?,
            avg_temp_c = ?, kilojoules = ?, workout_type = ?,
            edited = 1
      WHERE id = ? AND profile_id = ?`
  ).run(
    f.notes,
    f.duration_min,
    f.distance_km,
    f.intensity,
    f.start_time,
    f.end_time,
    f.components,
    f.avg_hr,
    f.max_hr,
    f.elevation_m,
    f.avg_speed_kmh,
    f.max_speed_kmh,
    f.relative_effort,
    f.avg_power_w,
    f.max_power_w,
    f.weighted_avg_power_w,
    f.avg_cadence,
    f.avg_temp_c,
    f.kilojoules,
    f.workout_type,
    keepId,
    profileId
  );
}
