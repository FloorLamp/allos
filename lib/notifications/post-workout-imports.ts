// The no-finish fallback for IMPORTS (#1154 §B2): after an integration sync
// lands rows, arm the delayed post-workout dispatch for any of TODAY's imported
// activities first seen in the last few minutes — a synced session that ended
// hours ago (outside the presence flagship's 60-min finished window) still gets
// its post-workout doses delivered instead of depending on a bucket slot that
// may already have passed. The dispatch core's only-when-pending + one-shot
// marker keep this from ever nudging twice, and its fire-time verification
// skips a row that isn't a completed today-session. Profile-scoped.
//
// Kept apart from ./post-workout-queue (the pure timer machinery, DB-free and
// unit-testable) because this half reads the DB.

import { db, today } from "../db";
import { queuePostWorkoutDispatch } from "./post-workout-queue";

// How far back a just-synced import row still counts as "fresh". Generous
// relative to a sync run's duration; the per-activity one-shot marker makes
// re-arming across overlapping syncs a no-op, so the width only bounds
// redundant timer churn.
const IMPORT_ARM_WINDOW_MIN = 10;

export function queuePostWorkoutForFreshImports(profileId: number): void {
  const date = today(profileId);
  const rows = db
    .prepare(
      `SELECT id FROM activities
        WHERE profile_id = ? AND date = ? AND source IS NOT NULL
          AND created_at >= datetime('now', ?)`
    )
    .all(profileId, date, `-${IMPORT_ARM_WINDOW_MIN} minutes`) as {
    id: number;
  }[];
  for (const r of rows) queuePostWorkoutDispatch(profileId, r.id);
}
