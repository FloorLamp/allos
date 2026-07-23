// The Open-Meteo weather/UV adapter (issue #1172). Open-Meteo is the recommended
// source for this app's self-hosted, offline-leaning, NO-ACCOUNT posture: no API key,
// both signals in one API (hourly uv_index AND shortwave/direct/diffuse irradiance in
// W/m²), a FREE historical archive (ERA5) that lets us backfill the UV for already-
// logged outdoor minutes, and uv_index_clear_sky alongside actual UV (the degradation
// ladder's clear-sky rung, as a field). The provider sits behind the small WeatherSource
// interface so the source is SWAPPABLE (an OpenWeatherMap adapter, or a self-hosted
// Open-Meteo, drops in without touching the sync/cache/dose layers) — default is
// Open-Meteo.
//
// Split: the PURE parse (parseOpenMeteoHourly) is unit-tested with fixtures; the fetch
// (openMeteoFetch) is the only network touch and is injected into the sync so tests run
// fully offline. Coordinates handed here are already the coarse (~0.1°/~11 km) home
// location — nothing sharper ever reaches an outbound request.

// One hour of the cached series (local wall-clock hour for the location's timezone, so
// it crosses directly with the local-time daylight/activity windows). Any field may be
// null when the provider omits it for that hour.
export interface HourlyUvRow {
  // Local hour timestamp "YYYY-MM-DDTHH:00" (Open-Meteo `timezone` param = the
  // location's IANA zone), the natural dedup key together with the location.
  hourTs: string;
  uvIndex: number | null;
  uvIndexClearSky: number | null;
  shortwaveRadiation: number | null; // W/m²
  directRadiation: number | null; // W/m²
  diffuseRadiation: number | null; // W/m²
}

// What every source returns for a (location, date-range, timezone) request.
export interface WeatherFetchResult {
  ok: boolean;
  rows: HourlyUvRow[];
  status?: number; // HTTP status on a non-OK response (0 = network error/timeout)
  error?: string;
}

// The swappable source contract. `fetchHourly` returns the hourly UV + irradiance
// series for a coarse location over [startDate, endDate] (YYYY-MM-DD, inclusive) in the
// given IANA timezone, choosing the forecast vs. historical-archive endpoint by date.
export interface WeatherSource {
  id: string;
  fetchHourly(
    lat: number,
    lng: number,
    startDate: string,
    endDate: string,
    timezone: string
  ): Promise<WeatherFetchResult>;
}

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const TIMEOUT_MS = 15_000;

// The hourly variables we request. uv_index + uv_index_clear_sky (the headline + the
// clear-sky degradation field) and the three irradiance components (W/m²).
const HOURLY_VARS = [
  "uv_index",
  "uv_index_clear_sky",
  "shortwave_radiation",
  "direct_radiation",
  "diffuse_radiation",
] as const;

// The ERA5 archive lags real time by ~5 days; anything on/after this cutoff must come
// from the forecast endpoint (which also serves recent past days), older dates from the
// free archive. Kept as a pure helper so the endpoint choice is testable.
export const ARCHIVE_LAG_DAYS = 5;

// Pick the endpoint for a request END date relative to `today` (YYYY-MM-DD): dates that
// reach within ARCHIVE_LAG_DAYS of today (or the future) use the forecast API; strictly
// older ranges use the historical archive. A range straddling the cutoff uses forecast
// (which serves ~92 past days), so we never miss recent hours.
export function chooseEndpoint(
  endDate: string,
  today: string
): "forecast" | "archive" {
  const cutoff = shiftDate(today, -ARCHIVE_LAG_DAYS);
  return endDate >= cutoff ? "forecast" : "archive";
}

function shiftDate(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// PURE: parse an Open-Meteo hourly response body into HourlyUvRow[]. Tolerant of
// missing arrays/fields (a variable the endpoint didn't return → all-null for that
// field). Both the forecast and archive endpoints share this `{ hourly: { time, ... }}`
// shape, so ONE parser covers both. Rows come back in the provider's order (ascending
// time); the caller dedups on (location, hourTs).
export function parseOpenMeteoHourly(json: unknown): HourlyUvRow[] {
  const body = (json ?? {}) as { hourly?: Record<string, unknown> };
  const hourly = body.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const time = hourly.time as unknown[];
  const col = (name: string): unknown[] =>
    Array.isArray(hourly[name]) ? (hourly[name] as unknown[]) : [];
  const uv = col("uv_index");
  const uvClear = col("uv_index_clear_sky");
  const sw = col("shortwave_radiation");
  const dir = col("direct_radiation");
  const dif = col("diffuse_radiation");

  const rows: HourlyUvRow[] = [];
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (typeof t !== "string") continue;
    // Open-Meteo returns "YYYY-MM-DDTHH:MM"; normalize to the top-of-hour key.
    const hourTs = `${t.slice(0, 13)}:00`;
    rows.push({
      hourTs,
      uvIndex: num(uv[i]),
      uvIndexClearSky: num(uvClear[i]),
      shortwaveRadiation: num(sw[i]),
      directRadiation: num(dir[i]),
      diffuseRadiation: num(dif[i]),
    });
  }
  return rows;
}

// Today (UTC) — the archive/forecast cutoff reference. Split out so a test can pass its
// own `today` into chooseEndpoint without stubbing the clock.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// The one network touch. Builds the Open-Meteo URL (forecast vs. archive by date),
// fetches with a short timeout, and returns the parsed rows or a graceful failure
// (never throws) so the sync records a failed event and degrades. No key, no auth.
export async function openMeteoFetch(
  lat: number,
  lng: number,
  startDate: string,
  endDate: string,
  timezone: string
): Promise<WeatherFetchResult> {
  const endpoint = chooseEndpoint(endDate, todayUtc());
  const base = endpoint === "archive" ? ARCHIVE_BASE : FORECAST_BASE;
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: HOURLY_VARS.join(","),
    timezone,
    start_date: startDate,
    end_date: endDate,
  });
  try {
    const res = await fetch(`${base}?${qs.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, rows: [], status: res.status };
    const rows = parseOpenMeteoHourly(await res.json());
    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// The default source: Open-Meteo. Swap this (or inject another WeatherSource into
// runWeatherSync) to change providers.
export const openMeteoSource: WeatherSource = {
  id: "open-meteo",
  fetchHourly: openMeteoFetch,
};
