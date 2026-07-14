import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 035: active-energy samples can describe an imported activity, but
// their original association was implicit in the provider/time window. Activity
// clocks are user-editable and profile timezones can change, so that window is
// not a stable relationship. Persist the activity's source-owned external_id on
// the sample instead. The column stays nullable because most metric samples are
// standalone observations rather than activity attributes.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (row) => row.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "metric_samples").has("activity_external_id")) {
    db.exec(`ALTER TABLE metric_samples ADD COLUMN activity_external_id TEXT;`);
  }

  // Backfill only relationships the old persisted keys can prove. Health Connect
  // derives an activity external_id from the sample start instant, but its active-
  // calorie records are independent intervals: require the same local day and
  // duration too so a shared start cannot attach an unrelated measurement.
  db.exec(`
    UPDATE metric_samples AS sample
       SET activity_external_id = (
         SELECT activity.external_id
           FROM activities AS activity
          WHERE activity.profile_id = sample.profile_id
            AND activity.source = sample.source
            AND activity.external_id = sample.source || ':' || sample.start_time
            AND activity.date = sample.date
            AND activity.duration_min = CAST(ROUND(
              (julianday(sample.end_time) - julianday(sample.start_time)) * 1440
            ) AS INTEGER)
          LIMIT 1
       )
     WHERE sample.metric = 'active_kcal'
       AND sample.source = 'health-connect'
       AND sample.activity_external_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM activities AS activity
          WHERE activity.profile_id = sample.profile_id
            AND activity.source = sample.source
            AND activity.external_id = sample.source || ':' || sample.start_time
            AND activity.date = sample.date
            AND activity.duration_min = CAST(ROUND(
              (julianday(sample.end_time) - julianday(sample.start_time)) * 1440
            ) AS INTEGER)
       );

    -- Old Oura samples retained the workout date and exact elapsed interval, but
    -- normalized timestamps to UTC while activities retained the ring's literal
    -- local clock. Link only when date + rounded duration identifies one workout.
    UPDATE metric_samples AS sample
       SET activity_external_id = (
         SELECT MIN(activity.external_id)
           FROM activities AS activity
          WHERE activity.profile_id = sample.profile_id
            AND activity.source = sample.source
            AND activity.date = sample.date
            AND activity.duration_min = CAST(ROUND(
              (julianday(sample.end_time) - julianday(sample.start_time)) * 1440
            ) AS INTEGER)
            AND activity.external_id IS NOT NULL
       )
     WHERE sample.metric = 'active_kcal'
       AND sample.source = 'oura'
       AND sample.activity_external_id IS NULL
       AND 1 = (
         SELECT COUNT(*)
           FROM activities AS activity
          WHERE activity.profile_id = sample.profile_id
            AND activity.source = sample.source
            AND activity.date = sample.date
            AND activity.duration_min = CAST(ROUND(
              (julianday(sample.end_time) - julianday(sample.start_time)) * 1440
            ) AS INTEGER)
            AND activity.external_id IS NOT NULL
       )
       AND 1 = (
         SELECT COUNT(*)
           FROM metric_samples AS peer
          WHERE peer.profile_id = sample.profile_id
            AND peer.source = sample.source
            AND peer.metric = sample.metric
            AND peer.date = sample.date
            AND CAST(ROUND(
              (julianday(peer.end_time) - julianday(peer.start_time)) * 1440
            ) AS INTEGER) = CAST(ROUND(
              (julianday(sample.end_time) - julianday(sample.start_time)) * 1440
            ) AS INTEGER)
       );

    -- Strava historically stored the activity's local wall-clock numerals in
    -- both records. Link only a unique exact window; an already-edited or
    -- ambiguous legacy row stays NULL until its next sync supplies the id.
    UPDATE metric_samples AS sample
       SET activity_external_id = (
         SELECT MIN(activity.external_id)
           FROM activities AS activity
          WHERE activity.profile_id = sample.profile_id
            AND activity.source = sample.source
            AND activity.date = sample.date
            AND activity.start_time = substr(sample.start_time, 12, 5)
            AND activity.end_time = substr(sample.end_time, 12, 5)
            AND activity.external_id IS NOT NULL
       )
     WHERE sample.metric = 'active_kcal'
       AND sample.source = 'strava'
       AND sample.activity_external_id IS NULL
       AND 1 = (
         SELECT COUNT(*)
           FROM activities AS activity
          WHERE activity.profile_id = sample.profile_id
            AND activity.source = sample.source
            AND activity.date = sample.date
            AND activity.start_time = substr(sample.start_time, 12, 5)
            AND activity.end_time = substr(sample.end_time, 12, 5)
            AND activity.external_id IS NOT NULL
       );

    CREATE INDEX IF NOT EXISTS idx_metric_samples_activity
      ON metric_samples(profile_id, source, activity_external_id, metric)
      WHERE activity_external_id IS NOT NULL;
  `);
}

export const migration: Migration = {
  id: 35,
  name: "035-metric-sample-activity-link",
  up,
};
