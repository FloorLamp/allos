import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 032 (issue #569): capture activity GPS routes into a child table.
//
// The Strava sync already fetches the detailed activity object for every new
// activity (for calories) — and that payload carries an encoded route polyline
// (`map.summary_polyline`) plus start/end coordinates that `mapStravaActivity`
// currently drops on the floor (they only ever reached the admin raw-payload log).
// Capturing them costs ZERO new API calls.
//
// STORAGE — a child table, not columns on the hot `activities` row. Polylines run
// to kilobytes; keeping them off `activities` keeps timeline/trends scans lean. The
// table is 1:1 with an activity, keyed UNIQUE on `activity_id` so the sync's
// `ON CONFLICT(activity_id)` upsert is idempotent. It carries no `profile_id` of its
// own — it reaches the acting profile via a JOIN to `activities` exactly like
// `exercise_sets` (so the profile-scoping test covers it through the child-table
// JOIN rule; it is deliberately NOT in OWNED_TABLES). `ON DELETE CASCADE` handles
// profile deletion through the parent, mirroring `exercise_sets`; `source` is stored
// provider-agnostically ('strava' today) so a future provider reuses the table.
//
// Additive CREATE TABLE guarded with IF NOT EXISTS so the non-version-gated
// migrate() replay is a no-op; production runs it once behind the user_version gate.
// Determinism (spec): reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS activity_routes (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       activity_id INTEGER NOT NULL UNIQUE REFERENCES activities(id) ON DELETE CASCADE,
       polyline    TEXT NOT NULL,        -- Google encoded polyline, as delivered
       start_lat   REAL,
       start_lng   REAL,
       end_lat     REAL,
       end_lng     REAL,
       source      TEXT NOT NULL         -- 'strava' (provider-agnostic by design)
     );`
  );
}

export const migration: Migration = {
  id: 32,
  name: "032-activity-routes",
  up,
};
