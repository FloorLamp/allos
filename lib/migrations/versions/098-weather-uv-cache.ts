import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 098 (issue #1172): the cached hourly weather/UV series behind the
// Open-Meteo integration and the two-sided UV-dose sun model.
//
// SCOPING — GLOBAL, LOCATION-KEYED, NOT PROFILE-OWNED (a deliberate decision). The UV
// at a coordinate+hour is the SAME physical fact for everyone; keying the cache by the
// coarse home location (~0.1°/~11 km, the only precision lib/home-location ever stores)
// + the local hour means two profiles sharing a city share one cached row instead of
// duplicating the series per profile. So this table carries NO `profile_id`: it is NOT
// in lib/owned-tables.ts, NOT cleared by deleteProfile, and NOT part of the per-profile
// portable export — it is derived, re-fetchable public weather data, not personal data
// (the home location that seeds a fetch is the PHI-adjacent part, and that already lives
// in profile_settings). The per-profile audit trail is the standard integration_sync_
// events row the sync appends under the acting profile; the cache itself is global.
//
// KEY. (lat, lng, hour_ts) is the natural dedup key — the sync UPSERTs on it and never
// duplicates an hour (the idempotency invariant, docs/internals/integrations-sync.md).
// `hour_ts` is the location's LOCAL wall-clock top-of-hour "YYYY-MM-DDTHH:00", so it
// crosses directly with the local-time daylight/activity windows the dose model uses.
// `source` records which adapter produced the row (open-meteo today, swappable). The UV
// + irradiance columns are all nullable (a provider/endpoint may omit a variable for an
// hour); uv_index_clear_sky is the degradation-ladder clear-sky field.
//
// CREATE ... IF NOT EXISTS + the index guards keep the non-version-gated migrate()
// replay a no-op. Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_uv_hours (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      lat                REAL NOT NULL,
      lng                REAL NOT NULL,
      hour_ts            TEXT NOT NULL,
      uv_index           REAL,
      uv_index_clear_sky REAL,
      shortwave_radiation REAL,
      direct_radiation    REAL,
      diffuse_radiation   REAL,
      source             TEXT NOT NULL DEFAULT 'open-meteo',
      fetched_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (lat, lng, hour_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_weather_uv_hours_loc_day
      ON weather_uv_hours(lat, lng, hour_ts);
  `);
}

export const migration: Migration = {
  id: 98,
  name: "098-weather-uv-cache",
  up,
};
