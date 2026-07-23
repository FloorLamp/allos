import type Database from "better-sqlite3";

// The cross-source duplicate ACTIVITY pair (issue #10, Phase 2) that Data → Review
// flags as a HIGH-confidence duplicate: a manually-logged "Morning run" and a Strava-
// imported "Afternoon Run" on one day with overlapping clock times. Extracted into a
// shared seeder so BOTH the initial seed (e2e/seed-events.ts) and import-dedup.spec.ts
// use the SAME fixture: the spec MERGES (consumes) the pair, so it re-seeds in a
// beforeEach to stay repeat-safe (#868). Synthetic data only.
export const DUP_DATE = "2026-07-07";

// Reset the dup-review fixture to its UNMERGED state on `profileId`: clear the pair's
// activities + any recorded pair decision, then re-insert the manual + Strava rows.
// Idempotent — the deletes are scoped to THIS fixture's titles + external_id (a blanket
// source='strava' delete would eat the journal-provenance "Strava morning ride" when
// the frozen clock rolls a relative daysAgo onto DUP_DATE).
export function seedDupReviewPair(
  db: Database.Database,
  profileId: number
): void {
  db.prepare(
    `DELETE FROM activities WHERE profile_id = ? AND date = ? AND (external_id = 'strava:e2e-run-1' OR title IN ('Morning run', 'Afternoon Run'))`
  ).run(profileId, DUP_DATE);
  db.prepare(`DELETE FROM import_pair_decisions WHERE profile_id = ?`).run(
    profileId
  );

  const insActivity = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km,
        start_time, end_time, source, external_id, edited)
     VALUES (?, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  // Manual entry (source NULL): the user's own "Morning run".
  insActivity.run(
    profileId,
    DUP_DATE,
    "Morning run",
    32,
    5.0,
    "08:00",
    "08:32",
    null,
    null
  );
  // Strava import of the same run, overlapping times → detected as a duplicate.
  insActivity.run(
    profileId,
    DUP_DATE,
    "Afternoon Run",
    33,
    5.1,
    "08:02",
    "08:35",
    "strava",
    "strava:e2e-run-1"
  );
}
