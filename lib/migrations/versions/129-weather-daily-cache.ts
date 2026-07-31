import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 129 (issue #1726): the cached DAILY weather series — the substrate the
// weather-derived situations (heatwave, cold snap, pressure swing, high pollen, poor
// air quality) evaluate their predicates over, and the same rows the session/day
// weather stamps and the training-tolerance envelope read.
//
// WHY A SECOND TABLE RATHER THAN MORE COLUMNS ON weather_uv_hours. The hourly table is
// the UV/irradiance series: its grain is an HOUR because the dose model crosses outdoor
// minutes with the UV of the hours they touched. Everything this migration adds is a
// DAILY aggregate the provider itself publishes per day (daily max/min temperature,
// daily mean pressure, precipitation sum) or that only makes sense as a day summary
// (the day's peak AQI / pollen). Widening the hourly table would store each of those 24
// times per day and make "was yesterday a heatwave day?" a GROUP BY instead of a point
// read. Same cache family, same posture, different grain.
//
// SCOPING — GLOBAL, LOCATION-KEYED, NOT PROFILE-OWNED, exactly as migration 100 argued
// for weather_uv_hours: the weather at a coordinate on a date is one physical fact, so
// two profiles in the same city share one row. The table carries NO `profile_id`, is
// NOT in lib/owned-tables.ts, is NOT cleared by deleteProfile, and is NOT part of the
// per-profile portable export — it is derived, re-fetchable public weather data. The
// PHI-adjacent part is the coarse home location that seeds a fetch, and that already
// lives in profile_settings. The per-profile audit trail stays the integration_sync_
// events row the sync appends under the acting profile. The schema-derived owned-table
// agreement test computes its set from CREATE TABLE blocks declaring `profile_id`, so a
// column-less table sits outside it with no allowlist entry needed.
//
// KEY. (lat, lng, date) is the natural dedup key — the sync UPSERTs on it and never
// duplicates a day (the idempotency invariant, docs/internals/integrations-sync.md).
// `date` is the location's LOCAL calendar day "YYYY-MM-DD" (Open-Meteo is asked for the
// location's IANA timezone), so it crosses directly with the local-date activity rows
// and the per-profile timezone the predicates are evaluated in.
//
// COLUMNS. Every measurement is NULLABLE: the two upstream endpoints are independent
// (the forecast/archive weather API and the air-quality API), either can omit a
// variable for a day, and a partial row must remain writable — a predicate with no data
// simply does not fire (silence over guessing). Units are the canonical storage units
// (°C, hPa, mm); the display layer converts per the login's unit preference.
//
//   temp_max_c / temp_min_c — daily maximum/minimum 2 m air temperature (°C). The
//     heatwave and cold-snap predicates read these.
//   pressure_msl_hpa — daily MEAN sea-level pressure (hPa). Sea-level-reduced (not
//     station surface pressure) so a day-over-day delta is an actual synoptic change
//     rather than an altitude artifact — the migraine-relevant pressure-swing signal.
//   precipitation_mm — daily precipitation sum (mm). Not a situation input; it is what
//     the outdoor-training viability scan and the day stamps read, and it arrives free
//     in the same daily request.
//   weather_code — the WMO weather-interpretation code for the day (integer, e.g. 0
//     clear, 61 rain). Stored raw; the label mapping is a pure display concern.
//   uv_index_max — the day's peak UV index. The hourly table remains the source for
//     DOSE math; this is the cheap day-level figure the digest/planning lines read
//     without scanning 24 hourly rows.
//   aqi — the day's peak US AQI (unitless index). US AQI rather than European AQI
//     because its category breakpoints (100 = "unhealthy for sensitive groups") are the
//     ones the poor-air-quality threshold is stated against.
//   pollen_tree / pollen_grass / pollen_weed — the day's peak pollen concentration
//     (grains/m³) for the three families, each the maximum across the provider's
//     species in that family (alder+birch+olive → tree, grass → grass,
//     mugwort+ragweed → weed). Family grain, not species grain: the predicate and the
//     copy are per POLLEN TYPE, and a per-species column set would be provider-shaped
//     rather than domain-shaped.
//   source / fetched_at — which adapter produced the row, and when.
//
// No secondary index: `UNIQUE (lat, lng, date)` already materializes the index both
// reads use (the point upsert probe and the `date BETWEEN ? AND ?` range scan are both
// prefix probes on it), so another index over the same columns would be dead weight.
//
// CREATE ... IF NOT EXISTS keeps the non-version-gated migrate() replay a no-op.
// Determinism: reads only the DB + its own constants.

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_days (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      lat              REAL NOT NULL,
      lng              REAL NOT NULL,
      date             TEXT NOT NULL,
      temp_max_c       REAL,
      temp_min_c       REAL,
      pressure_msl_hpa REAL,
      precipitation_mm REAL,
      weather_code     INTEGER,
      uv_index_max     REAL,
      aqi              REAL,
      pollen_tree      REAL,
      pollen_grass     REAL,
      pollen_weed      REAL,
      source           TEXT NOT NULL DEFAULT 'open-meteo',
      fetched_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (lat, lng, date)
    );
  `);
}

export const migration: Migration = {
  id: 129,
  name: "129-weather-daily-cache",
  up,
};
