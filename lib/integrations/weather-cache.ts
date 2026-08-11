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
import type { DailyWeatherRow, HourlyUvRow } from "./open-meteo";
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
  // Precipitation in the hour, mm (#1967). Null on every row cached before the column
  // existed and on any hour the provider omitted it — the readers treat a partial day as
  // having no timing rather than guessing from the hours they do have.
  precipitationMm: number | null;
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
            direct_radiation, diffuse_radiation, precipitation_mm
       FROM weather_uv_hours
      WHERE lat = ? AND lng = ? AND hour_ts = ?`
  );
  const ins = db.prepare(
    `INSERT INTO weather_uv_hours
       (lat, lng, hour_ts, uv_index, uv_index_clear_sky,
        shortwave_radiation, direct_radiation, diffuse_radiation,
        precipitation_mm, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lat, lng, hour_ts) DO UPDATE SET
       uv_index = excluded.uv_index,
       uv_index_clear_sky = excluded.uv_index_clear_sky,
       shortwave_radiation = excluded.shortwave_radiation,
       direct_radiation = excluded.direct_radiation,
       diffuse_radiation = excluded.diffuse_radiation,
       precipitation_mm = excluded.precipitation_mm,
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
            precipitation_mm: number | null;
          }
        | undefined;
      const hadRow = pre !== undefined;
      const valuesEqual =
        hadRow &&
        eq(num(pre!.uv_index), r.uvIndex) &&
        eq(num(pre!.uv_index_clear_sky), r.uvIndexClearSky) &&
        eq(num(pre!.shortwave_radiation), r.shortwaveRadiation) &&
        eq(num(pre!.direct_radiation), r.directRadiation) &&
        eq(num(pre!.diffuse_radiation), r.diffuseRadiation) &&
        eq(num(pre!.precipitation_mm), r.precipitationMm);
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
          r.precipitationMm,
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
  return getUvHoursForDays(lat, lng, [date]).get(date) ?? [];
}

// The same series for a SET of local dates in ONE read (#2113) — a Map date→hours,
// carrying an entry only for the dates that have cached rows (the single-date reader
// above turns a missing entry back into its empty array). The Timeline's UV chip asks
// about every rendered day at once; asking day-by-day cost one statement per day.
//
// Bounded by hour_ts BETWEEN the set's first and last day so the UNIQUE(lat, lng,
// hour_ts) index still range-scans, then pruned by the date set itself — a feed
// spanning a year must not drag in every cached hour between its two ends. The upper
// bound is `<{last}U` because 'U' is the codepoint after 'T': it admits the whole
// `{last}T23:00` day and nothing of the next date.
export function getUvHoursForDays(
  lat: number,
  lng: number,
  dates: readonly string[]
): Map<string, CachedUvHour[]> {
  const out = new Map<string, CachedUvHour[]>();
  const wanted = [...new Set(dates)].sort();
  if (wanted.length === 0) return out;
  const la = roundCoord(lat);
  const ln = roundCoord(lng);
  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT hour_ts, uv_index, uv_index_clear_sky, shortwave_radiation,
              direct_radiation, diffuse_radiation, precipitation_mm
         FROM weather_uv_hours
        WHERE lat = ? AND lng = ?
          AND hour_ts >= ? AND hour_ts < ?
          AND substr(hour_ts, 1, 10) IN (${placeholders})
        ORDER BY hour_ts`
    )
    .all(la, ln, `${wanted[0]}T`, `${wanted[wanted.length - 1]}U`, ...wanted) as {
    hour_ts: string;
    uv_index: number | null;
    uv_index_clear_sky: number | null;
    shortwave_radiation: number | null;
    direct_radiation: number | null;
    diffuse_radiation: number | null;
    precipitation_mm: number | null;
  }[];
  for (const r of rows) {
    const date = r.hour_ts.slice(0, 10);
    const list = out.get(date) ?? [];
    list.push({
      hourTs: r.hour_ts,
      uvIndex: num(r.uv_index),
      uvIndexClearSky: num(r.uv_index_clear_sky),
      shortwaveRadiation: num(r.shortwave_radiation),
      directRadiation: num(r.direct_radiation),
      diffuseRadiation: num(r.diffuse_radiation),
      precipitationMm: num(r.precipitation_mm),
    });
    out.set(date, list);
  }
  return out;
}

// ---- The DAILY cache (issue #1726) ------------------------------------------------
//
// Same table family, same posture, one grain coarser: weather_days holds one row per
// (coarse location, LOCAL date) with the daily aggregates the derived-situation
// predicates, the day/session stamps, and the outdoor-viability scan read. Global and
// location-keyed for the same reason the hourly cache is (migration 129's rationale),
// so nothing here filters by profile_id.

// A cached day as read back by the predicate/stamp layers.
export interface CachedWeatherDay {
  date: string;
  tempMaxC: number | null;
  tempMinC: number | null;
  pressureMslHpa: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  uvIndexMax: number | null;
  aqi: number | null;
  pollenTree: number | null;
  pollenGrass: number | null;
  pollenWeed: number | null;
}

// The measurement columns, in one list, so the upsert's compare/insert and the read's
// projection can never drift apart.
const DAY_COLUMNS = [
  "temp_max_c",
  "temp_min_c",
  "pressure_msl_hpa",
  "precipitation_mm",
  "weather_code",
  "uv_index_max",
  "aqi",
  "pollen_tree",
  "pollen_grass",
  "pollen_weed",
] as const;

type DayColumn = (typeof DAY_COLUMNS)[number];

// A fetched row's value for a storage column — the ONE mapping between the provider
// shape and the table shape.
function dayValue(r: DailyWeatherRow, column: DayColumn): number | null {
  switch (column) {
    case "temp_max_c":
      return r.tempMaxC;
    case "temp_min_c":
      return r.tempMinC;
    case "pressure_msl_hpa":
      return r.pressureMslHpa;
    case "precipitation_mm":
      return r.precipitationMm;
    case "weather_code":
      return r.weatherCode;
    case "uv_index_max":
      return r.uvIndexMax;
    case "aqi":
      return r.aqi;
    case "pollen_tree":
      return r.pollenTree;
    case "pollen_grass":
      return r.pollenGrass;
    case "pollen_weed":
      return r.pollenWeed;
  }
}

// Upsert the fetched daily series for a coarse location, keyed on (lat, lng, date).
// Idempotent exactly as the hourly upsert is: same values ⇒ `unchanged`, changed value
// ⇒ `updated`, new day ⇒ `inserted`.
//
// PARTIAL-FETCH SAFETY (the load-bearing difference from the hourly upsert): the row is
// assembled from TWO independent endpoints, so a fetch that returned weather but not
// air quality carries nulls for AQI/pollen. Writing those nulls would ERASE a
// previously-cached pollen reading — a re-fetch destroying data it simply didn't ask
// for. So each column is COALESCEd: a null in the incoming row leaves the stored value
// alone, and only a real reading ever overwrites. A day whose incoming values are all
// null-or-equal is therefore `unchanged`, not a destructive `updated`.
//
// As with the hourly cache there are no manually-entered rows here (provider-only,
// derived public weather), so the never-overwrite-a-manual-edit invariant is satisfied
// by there being no manual rows to protect.
export function upsertWeatherDays(
  lat: number,
  lng: number,
  rows: readonly DailyWeatherRow[],
  source: string
): UpsertCounts {
  const la = roundCoord(lat);
  const ln = roundCoord(lng);
  const counts = emptyCounts();
  if (rows.length === 0) return counts;

  const sel = db.prepare(
    `SELECT ${DAY_COLUMNS.join(", ")}
       FROM weather_days
      WHERE lat = ? AND lng = ? AND date = ?`
  );
  const ins = db.prepare(
    `INSERT INTO weather_days (lat, lng, date, ${DAY_COLUMNS.join(", ")}, source, fetched_at)
     VALUES (?, ?, ?, ${DAY_COLUMNS.map(() => "?").join(", ")}, ?, datetime('now'))
     ON CONFLICT(lat, lng, date) DO UPDATE SET
       ${DAY_COLUMNS.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(",\n       ")},
       source = excluded.source,
       fetched_at = excluded.fetched_at`
  );

  writeTx(() => {
    for (const r of rows) {
      const pre = sel.get(la, ln, r.date) as
        Record<DayColumn, number | null> | undefined;
      const hadRow = pre !== undefined;
      // Unchanged when every incoming value is either absent (COALESCE would keep the
      // stored one) or equal to what is stored.
      const valuesEqual =
        hadRow &&
        DAY_COLUMNS.every((c) => {
          const next = dayValue(r, c);
          return next == null || eq(num(pre![c]), next);
        });
      const disposition = classifyUpsert(hadRow, valuesEqual);
      if (disposition !== "unchanged") {
        ins.run(
          la,
          ln,
          r.date,
          ...DAY_COLUMNS.map((c) => dayValue(r, c)),
          source
        );
      }
      tallyUpsert(counts, disposition);
    }
  });
  return counts;
}

// The cached daily series for a coarse location over an INCLUSIVE local-date range,
// ordered by date. Empty when nothing is cached (every predicate then has no data and
// stays silent). Global read — no profile filter.
export function getWeatherDays(
  lat: number,
  lng: number,
  startDate: string,
  endDate: string
): CachedWeatherDay[] {
  const la = roundCoord(lat);
  const ln = roundCoord(lng);
  const rows = db
    .prepare(
      `SELECT date, ${DAY_COLUMNS.join(", ")}
         FROM weather_days
        WHERE lat = ? AND lng = ? AND date >= ? AND date <= ?
        ORDER BY date`
    )
    .all(la, ln, startDate, endDate) as ({ date: string } & Record<
    DayColumn,
    number | null
  >)[];
  return rows.map((r) => ({
    date: r.date,
    tempMaxC: num(r.temp_max_c),
    tempMinC: num(r.temp_min_c),
    pressureMslHpa: num(r.pressure_msl_hpa),
    precipitationMm: num(r.precipitation_mm),
    weatherCode: num(r.weather_code),
    uvIndexMax: num(r.uv_index_max),
    aqi: num(r.aqi),
    pollenTree: num(r.pollen_tree),
    pollenGrass: num(r.pollen_grass),
    pollenWeed: num(r.pollen_weed),
  }));
}
