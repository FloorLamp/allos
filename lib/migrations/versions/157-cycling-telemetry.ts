import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Strava's activity summary is intentionally kept on `activities`; the larger,
// optional cycling payloads live beside it. Streams are stored as the provider's
// compact keyed JSON object (one row per activity) rather than one SQLite row per
// sample. Laps and segment efforts are individually addressable because the ride
// page sorts and compares them.
//
// All three tables carry profile_id even though they also point at an activity.
// This makes ownership explicit, lets profile deletion remain complete while FKs
// are disabled for its subtree sweep, and keeps every runtime read independently
// profile-scoped.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_telemetry (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id         INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      activity_id        INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      source             TEXT NOT NULL,
      streams_json       TEXT NOT NULL,
      ftp_w              INTEGER,
      heart_rate_zones_json TEXT,
      power_zones_json   TEXT,
      snapshot_at        TEXT NOT NULL,
      UNIQUE(profile_id, activity_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_activity_telemetry_profile_activity
      ON activity_telemetry(profile_id, activity_id);

    CREATE TABLE IF NOT EXISTS activity_laps (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id         INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      activity_id        INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      source             TEXT NOT NULL,
      external_id        TEXT NOT NULL,
      lap_index          INTEGER NOT NULL,
      name               TEXT,
      distance_m         REAL,
      moving_time_sec    INTEGER,
      elapsed_time_sec   INTEGER,
      start_index        INTEGER,
      end_index          INTEGER,
      elevation_gain_m   REAL,
      average_speed_mps  REAL,
      max_speed_mps      REAL,
      average_cadence    REAL,
      average_watts      REAL,
      average_heartrate  REAL,
      max_heartrate      REAL,
      UNIQUE(profile_id, source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_activity_laps_profile_activity
      ON activity_laps(profile_id, activity_id, lap_index);

    CREATE TABLE IF NOT EXISTS activity_segment_efforts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id         INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      activity_id        INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      source             TEXT NOT NULL,
      external_id        TEXT NOT NULL,
      segment_id         TEXT,
      name               TEXT NOT NULL,
      distance_m         REAL,
      moving_time_sec    INTEGER,
      elapsed_time_sec   INTEGER,
      start_index        INTEGER,
      end_index          INTEGER,
      average_cadence    REAL,
      average_watts      REAL,
      average_heartrate  REAL,
      max_heartrate      REAL,
      pr_rank            INTEGER,
      kom_rank           INTEGER,
      UNIQUE(profile_id, source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_activity_segments_profile_activity
      ON activity_segment_efforts(profile_id, activity_id, start_index);
  `);
}

export const migration: Migration = {
  id: 157,
  name: "157-cycling-telemetry",
  up,
};
