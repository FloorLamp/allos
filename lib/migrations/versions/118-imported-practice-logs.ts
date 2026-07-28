import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 118: give wellness-practice sessions the same source identity and edit
// protection as other imported rows, then move unedited Fitbit meditation summaries
// out of training and into the wellness ledger.
//
// Existing manual practice rows keep NULL provenance and edited=0. The partial unique
// index applies only to imported rows. Historical Fitbit activities are migrated only
// when they are unedited and have no attached children; a user-owned correction or
// attachment keeps the original activity intact.
function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const existing = columns(db, "practice_logs");
    if (!existing.has("source"))
      db.exec(`ALTER TABLE practice_logs ADD COLUMN source TEXT`);
    if (!existing.has("external_id"))
      db.exec(`ALTER TABLE practice_logs ADD COLUMN external_id TEXT`);
    if (!existing.has("edited"))
      db.exec(
        `ALTER TABLE practice_logs ADD COLUMN edited INTEGER NOT NULL DEFAULT 0`
      );
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_logs_external
        ON practice_logs(profile_id, external_id)
        WHERE external_id IS NOT NULL;

      INSERT OR IGNORE INTO practice_logs
        (profile_id, practice, date, time, duration_min, source, external_id)
        SELECT a.profile_id, 'Meditation', a.date, a.start_time, a.duration_min,
               a.source, a.external_id
          FROM activities a
         WHERE a.source = 'fitbit-takeout'
           AND a.external_id IS NOT NULL
           AND a.external_id <> ''
           AND COALESCE(a.edited, 0) = 0
           AND LOWER(TRIM(a.title)) IN ('meditating', 'meditation')
           AND NOT EXISTS (
             SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM activity_routes r WHERE r.activity_id = a.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM activity_videos v WHERE v.activity_id = a.id
           );

      -- The migration runner disables FK enforcement while applying migrations, so
      -- fitness_assessments.activity_id's ON DELETE SET NULL cannot fire here.
      -- Perform the inbound-link transition explicitly for exactly the activities
      -- that the following DELETE will remove.
      UPDATE fitness_assessments
         SET activity_id = NULL
       WHERE activity_id IN (
         SELECT a.id
           FROM activities a
          WHERE a.source = 'fitbit-takeout'
            AND a.external_id IS NOT NULL
            AND a.external_id <> ''
            AND COALESCE(a.edited, 0) = 0
            AND LOWER(TRIM(a.title)) IN ('meditating', 'meditation')
            AND NOT EXISTS (
              SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM activity_routes r WHERE r.activity_id = a.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM activity_videos v WHERE v.activity_id = a.id
            )
       );

      DELETE FROM activities
       WHERE source = 'fitbit-takeout'
         AND external_id IS NOT NULL
         AND external_id <> ''
         AND COALESCE(edited, 0) = 0
         AND LOWER(TRIM(title)) IN ('meditating', 'meditation')
         AND NOT EXISTS (
           SELECT 1 FROM exercise_sets s WHERE s.activity_id = activities.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM activity_routes r WHERE r.activity_id = activities.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM activity_videos v WHERE v.activity_id = activities.id
         );
    `);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 118,
  name: "118-imported-practice-logs",
  up,
};
