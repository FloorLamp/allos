import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 149 (issue #1967): hourly PRECIPITATION on the global weather/UV cache.
//
// WHY. A weather-parked outdoor activity discloses itself in plain language now ("heavy
// rain in the morning") rather than as a bare number, and the timing half of that phrase
// is a question about WHEN the wet hours fall — which the daily aggregate cannot answer.
// weather_uv_hours already holds one row per (coarse location, local hour) and the sync
// already re-fetches a 14-day window every tick, so the hourly series is the natural and
// only place this belongs.
//
// ONE nullable column, no rebuild. Every existing row keeps NULL, and the phrase treats a
// day with too few cached hours as having no timing at all — it renders intensity alone
// rather than inventing a clause from a partial day. So nothing is backfilled and nothing
// needs to be: the next sync re-fetches the window and the upsert is idempotent per
// (lat, lng, hour_ts), which fills the column in place with no data migration.
//
// The table is GLOBAL and location-keyed (migration 100's rationale) — it carries no
// profile_id, is not in lib/owned-tables.ts, and a column does not change that.
//
// Guarded ADD COLUMN keeps a replay a pure no-op. Determinism: reads only the DB.

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (r) => r.name
    )
  );
}

export function up(db: Database.Database): void {
  if (!columnNames(db, "weather_uv_hours").has("precipitation_mm")) {
    db.exec(`ALTER TABLE weather_uv_hours ADD COLUMN precipitation_mm REAL`);
  }
}

export const migration: Migration = {
  id: 149,
  name: "149-weather-hourly-precipitation",
  up,
};
