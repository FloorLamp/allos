// The GLOBAL, location-keyed weather/UV cache read/write layer (issue #1172). The
// cached hourly Open-Meteo series lives in weather_uv_hours keyed on
// (lat, lng, hour_ts) — the natural dedup key — and is SHARED across profiles: UV at a
// coordinate+hour is one physical fact, so two profiles in the same city share rows
// (see migration 098 for the scoping rationale). This module is the ONLY writer/reader
// of that table; the sync (weather-sync) upserts through upsertUvHours, the dose read
// layer (lib/queries/weather) reads through getUvHoursForDay.
//
// The table has NO profile_id (it is not profile-owned), so nothing here filters by
// profile_id — the profile-scoping guard derives its owned set from the schema and
// won't require it. The per-profile audit is the integration_sync_events row the sync
// appends under the acting profile.

import { db, writeTx } from "@/lib/db";
import { roundCoord } from "@/lib/home-location";
import type { HourlyUvRow } from "./open-meteo";
import {
  classifyUpsert,
  emptyCounts,
  tallyUpsert,
  type UpsertCounts,
} from "./sync-log";

// A cached hour as read back for the dose model.
export interface CachedUvHour {
  hourTs: string;
  uvIndex: number | null;
  uvIndexClearSky: number | null;
  shortwaveRadiation: number | null;
  directRadiation: number | null;
  diffuseRadiation: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function eq(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  return a === b;
}

// Upsert the fetched hourly series for a coarse location, keyed on (lat, lng, hour_ts).
// Idempotent (the sync invariant, docs/internals/integrations-sync.md): a re-fetch of
// the same hour with the same values is `unchanged`, a changed value is `updated`, a
// new hour is `inserted`. There are NO manually-entered rows in this cache (it is
// provider-only, derived public weather), so the user-edit lock does not apply here —
// the "never overwrite a manual row" invariant is satisfied by there being none. lat/
// lng are coarsened to the storage precision so the key matches the home-location one.
export function upsertUvHours(
  lat: number,
  lng: number,
  rows: HourlyUvRow[],
  source: string
): UpsertCounts {
  const la = roundCoord(lat);
  const ln = roundCoord(lng);
  const counts = emptyCounts();
  if (rows.length === 0) return counts;

  const sel = db.prepare(
    `SELECT uv_index, uv_index_clear_sky, shortwave_radiation,
            direct_radiation, diffuse_radiation
       FROM weather_uv_hours
      WHERE lat = ? AND lng = ? AND hour_ts = ?`
  );
  const ins = db.prepare(
    `INSERT INTO weather_uv_hours
       (lat, lng, hour_ts, uv_index, uv_index_clear_sky,
        shortwave_radiation, direct_radiation, diffuse_radiation, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lat, lng, hour_ts) DO UPDATE SET
       uv_index = excluded.uv_index,
       uv_index_clear_sky = excluded.uv_index_clear_sky,
       shortwave_radiation = excluded.shortwave_radiation,
       direct_radiation = excluded.direct_radiation,
       diffuse_radiation = excluded.diffuse_radiation,
       source = excluded.source,
       fetched_at = excluded.fetched_at`
  );

  writeTx(() => {
    for (const r of rows) {
      const pre = sel.get(la, ln, r.hourTs) as
        | {
            uv_index: number | null;
            uv_index_clear_sky: number | null;
            shortwave_radiation: number | null;
            direct_radiation: number | null;
            diffuse_radiation: number | null;
          }
        | undefined;
      const hadRow = pre !== undefined;
      const valuesEqual =
        hadRow &&
        eq(num(pre!.uv_index), r.uvIndex) &&
        eq(num(pre!.uv_index_clear_sky), r.uvIndexClearSky) &&
        eq(num(pre!.shortwave_radiation), r.shortwaveRadiation) &&
        eq(num(pre!.direct_radiation), r.directRadiation) &&
        eq(num(pre!.diffuse_radiation), r.diffuseRadiation);
      const disposition = classifyUpsert(hadRow, valuesEqual);
      if (disposition !== "unchanged") {
        ins.run(
          la,
          ln,
          r.hourTs,
          r.uvIndex,
          r.uvIndexClearSky,
          r.shortwaveRadiation,
          r.directRadiation,
          r.diffuseRadiation,
          source
        );
      }
      tallyUpsert(counts, disposition);
    }
  });
  return counts;
}

// The cached hourly series for a coarse location on a LOCAL date (YYYY-MM-DD), ordered
// by hour. Empty when nothing is cached (the dose read layer then falls back to the
// clear-sky/minutes-only rungs). Global read — no profile filter.
export function getUvHoursForDay(
  lat: number,
  lng: number,
  date: string
): CachedUvHour[] {
  const la = roundCoord(lat);
  const ln = roundCoord(lng);
  const rows = db
    .prepare(
      `SELECT hour_ts, uv_index, uv_index_clear_sky, shortwave_radiation,
              direct_radiation, diffuse_radiation
         FROM weather_uv_hours
        WHERE lat = ? AND lng = ? AND hour_ts LIKE ?
        ORDER BY hour_ts`
    )
    .all(la, ln, `${date}T%`) as {
    hour_ts: string;
    uv_index: number | null;
    uv_index_clear_sky: number | null;
    shortwave_radiation: number | null;
    direct_radiation: number | null;
    diffuse_radiation: number | null;
  }[];
  return rows.map((r) => ({
    hourTs: r.hour_ts,
    uvIndex: num(r.uv_index),
    uvIndexClearSky: num(r.uv_index_clear_sky),
    shortwaveRadiation: num(r.shortwave_radiation),
    directRadiation: num(r.direct_radiation),
    diffuseRadiation: num(r.diffuse_radiation),
  }));
}
