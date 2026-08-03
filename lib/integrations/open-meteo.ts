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
  // Precipitation that fell in the hour, mm (#1967 — the timing half of a wet park's
  // plain-language description; the daily total cannot say WHEN it rained).
  precipitationMm: number | null;
}

// One DAY of the cached daily series (the location's LOCAL calendar day). The
// substrate the weather-derived situations evaluate their predicates over (#1726) and
// the day-level figures the session/day stamps and the training viability scan read.
// Every field is nullable: the weather and air-quality endpoints are independent and
// either can omit a variable for a day — a partial day is still worth caching, and a
// predicate with no data simply does not fire.
export interface DailyWeatherRow {
  // Local calendar day "YYYY-MM-DD" — the natural dedup key with the location.
  date: string;
  tempMaxC: number | null;
  tempMinC: number | null;
  // Daily MEAN sea-level pressure (hPa) — sea-level-reduced so a day-over-day delta is
  // a synoptic change, not an altitude artifact.
  pressureMslHpa: number | null;
  precipitationMm: number | null;
  // WMO weather-interpretation code for the day (0 clear … 95 thunderstorm).
  weatherCode: number | null;
  uvIndexMax: number | null;
  // The day's PEAK US AQI (the index whose 100 breakpoint the threshold is stated
  // against) and peak per-family pollen concentration (grains/m³).
  aqi: number | null;
  pollenTree: number | null;
  pollenGrass: number | null;
  pollenWeed: number | null;
}

// What every source returns for a (location, date-range, timezone) request.
export interface WeatherFetchResult {
  ok: boolean;
  rows: HourlyUvRow[];
  status?: number; // HTTP status on a non-OK response (0 = network error/timeout)
  error?: string;
}

// What a source returns for the DAILY request. Same graceful-failure shape.
export interface DailyFetchResult {
  ok: boolean;
  rows: DailyWeatherRow[];
  status?: number;
  error?: string;
  // Set when the weather half succeeded but the air-quality half did not: the rows are
  // still usable (temperature/pressure predicates work), pollen/AQI are simply absent.
  // A partial is NOT a sync failure — it degrades, it does not fail (the graceful-
  // degradation posture the whole weather feature is built on).
  partial?: string;
}

// The swappable source contract. `fetchHourly` returns the hourly UV + irradiance
// series for a coarse location over [startDate, endDate] (YYYY-MM-DD, inclusive) in the
// given IANA timezone, choosing the forecast vs. historical-archive endpoint by date.
// `fetchDaily` returns the daily aggregate series over the same window — weather
// (temperature/pressure/precipitation/UV peak) merged with air quality (AQI/pollen).
export interface WeatherSource {
  id: string;
  fetchHourly(
    lat: number,
    lng: number,
    startDate: string,
    endDate: string,
    timezone: string
  ): Promise<WeatherFetchResult>;
  fetchDaily(
    lat: number,
    lng: number,
    startDate: string,
    endDate: string,
    timezone: string
  ): Promise<DailyFetchResult>;
}

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
// The air-quality API is a SEPARATE Open-Meteo host with its own variable vocabulary
// (CAMS-backed). It is keyless like the others and serves both recent past days and a
// short forecast from one endpoint, so there is no archive/forecast split to make.
const AIR_QUALITY_BASE =
  "https://air-quality-api.open-meteo.com/v1/air-quality";
const TIMEOUT_MS = 15_000;

// The hourly variables we request. uv_index + uv_index_clear_sky (the headline + the
// clear-sky degradation field), the three irradiance components (W/m²), and hourly
// precipitation (mm) — which the weather-parking disclosure reads to say WHEN the rain
// falls, a question the daily total cannot answer (#1967).
const HOURLY_VARS = [
  "uv_index",
  "uv_index_clear_sky",
  "shortwave_radiation",
  "direct_radiation",
  "diffuse_radiation",
  "precipitation",
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
  const precip = col("precipitation");

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
      precipitationMm: num(precip[i]),
    });
  }
  return rows;
}

// The DAILY variables we request from the weather endpoint. Both the forecast and the
// archive endpoint publish this same set, so ONE parser covers both (as with hourly).
const DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "weather_code",
  "uv_index_max",
] as const;

// Pressure has no daily aggregate in Open-Meteo, so it comes back HOURLY and is meaned
// per local day here. Sea-level-reduced (`pressure_msl`), not station surface pressure.
const DAILY_HOURLY_VARS = ["pressure_msl"] as const;

// The air-quality variables. US AQI (the index whose 100 breakpoint the poor-air
// threshold is stated against) plus the per-species pollen concentrations, all hourly —
// aggregated to the day's PEAK here, because "was pollen high that day?" is a question
// about the day's worst hour, not its average.
const AIR_QUALITY_VARS = [
  "us_aqi",
  "alder_pollen",
  "birch_pollen",
  "olive_pollen",
  "grass_pollen",
  "mugwort_pollen",
  "ragweed_pollen",
] as const;

// Which pollen FAMILY each provider species belongs to. Family grain is the domain
// grain: the predicate and the copy speak of tree/grass/weed pollen, and the family's
// value is the max across its species (one high species makes the family high).
const POLLEN_FAMILY: Record<string, "tree" | "grass" | "weed"> = {
  alder_pollen: "tree",
  birch_pollen: "tree",
  olive_pollen: "tree",
  grass_pollen: "grass",
  mugwort_pollen: "weed",
  ragweed_pollen: "weed",
};

// The local date of an "YYYY-MM-DDTHH:MM" hourly timestamp.
function dateOf(t: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T/.test(t) ? t.slice(0, 10) : null;
}

// The max of two possibly-null numbers (null = no reading, never a zero).
function maxOrNull(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function emptyDay(date: string): DailyWeatherRow {
  return {
    date,
    tempMaxC: null,
    tempMinC: null,
    pressureMslHpa: null,
    precipitationMm: null,
    weatherCode: null,
    uvIndexMax: null,
    aqi: null,
    pollenTree: null,
    pollenGrass: null,
    pollenWeed: null,
  };
}

// PURE: parse an Open-Meteo `daily` response body (plus its hourly `pressure_msl`
// column, meaned per local day) into DailyWeatherRow[]. Tolerant of missing arrays and
// of a body carrying only one of the two blocks. Rows come back in provider order
// (ascending date); the caller dedups on (location, date).
export function parseOpenMeteoDaily(json: unknown): DailyWeatherRow[] {
  const body = (json ?? {}) as {
    daily?: Record<string, unknown>;
    hourly?: Record<string, unknown>;
  };

  const byDate = new Map<string, DailyWeatherRow>();
  const order: string[] = [];
  const dayFor = (date: string): DailyWeatherRow => {
    let row = byDate.get(date);
    if (!row) {
      row = emptyDay(date);
      byDate.set(date, row);
      order.push(date);
    }
    return row;
  };

  const daily = body.daily;
  if (daily && Array.isArray(daily.time)) {
    const col = (name: string): unknown[] =>
      Array.isArray(daily[name]) ? (daily[name] as unknown[]) : [];
    const time = daily.time as unknown[];
    const tmax = col("temperature_2m_max");
    const tmin = col("temperature_2m_min");
    const precip = col("precipitation_sum");
    const code = col("weather_code");
    const uvMax = col("uv_index_max");
    for (let i = 0; i < time.length; i++) {
      const t = time[i];
      if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t)) continue;
      const row = dayFor(t);
      row.tempMaxC = num(tmax[i]);
      row.tempMinC = num(tmin[i]);
      row.precipitationMm = num(precip[i]);
      const c = num(code[i]);
      row.weatherCode = c == null ? null : Math.round(c);
      row.uvIndexMax = num(uvMax[i]);
    }
  }

  // Hourly pressure → the day's MEAN. A mean (not a max) because the pressure-swing
  // predicate compares one day's typical pressure to another's; a single gusty hour
  // must not read as a front passing through.
  const hourly = body.hourly;
  if (hourly && Array.isArray(hourly.time)) {
    const time = hourly.time as unknown[];
    const press = Array.isArray(hourly.pressure_msl)
      ? (hourly.pressure_msl as unknown[])
      : [];
    const sums = new Map<string, { sum: number; n: number }>();
    for (let i = 0; i < time.length; i++) {
      const t = time[i];
      if (typeof t !== "string") continue;
      const date = dateOf(t);
      if (!date) continue;
      const v = num(press[i]);
      if (v == null) continue;
      const acc = sums.get(date) ?? { sum: 0, n: 0 };
      acc.sum += v;
      acc.n += 1;
      sums.set(date, acc);
    }
    for (const [date, acc] of sums) {
      if (acc.n === 0) continue;
      dayFor(date).pressureMslHpa = acc.sum / acc.n;
    }
  }

  return order.sort().map((d) => byDate.get(d)!);
}

// PURE: parse an Open-Meteo AIR-QUALITY response body into per-day peak AQI + per-family
// peak pollen. Hourly in, daily-max out (the day's worst hour is what "high pollen that
// day" means). Missing species are simply absent from the family max. Ascending date.
export function parseOpenMeteoAirQuality(json: unknown): DailyWeatherRow[] {
  const body = (json ?? {}) as { hourly?: Record<string, unknown> };
  const hourly = body.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const time = hourly.time as unknown[];
  const col = (name: string): unknown[] =>
    Array.isArray(hourly[name]) ? (hourly[name] as unknown[]) : [];
  const aqi = col("us_aqi");
  const species = Object.keys(POLLEN_FAMILY).map(
    (name) => [POLLEN_FAMILY[name], col(name)] as const
  );

  const byDate = new Map<string, DailyWeatherRow>();
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (typeof t !== "string") continue;
    const date = dateOf(t);
    if (!date) continue;
    let row = byDate.get(date);
    if (!row) {
      row = emptyDay(date);
      byDate.set(date, row);
    }
    row.aqi = maxOrNull(row.aqi, num(aqi[i]));
    for (const [family, values] of species) {
      const v = num(values[i]);
      if (v == null) continue;
      if (family === "tree") row.pollenTree = maxOrNull(row.pollenTree, v);
      else if (family === "grass")
        row.pollenGrass = maxOrNull(row.pollenGrass, v);
      else row.pollenWeed = maxOrNull(row.pollenWeed, v);
    }
  }
  return [...byDate.keys()].sort().map((d) => byDate.get(d)!);
}

// PURE: merge the weather half and the air-quality half into one row per date. The
// weather half owns temperature/pressure/precipitation/code/UV; the air half owns
// AQI/pollen; neither ever overwrites the other's fields, and a date present in only
// one half still yields a row (a partial day is worth caching). Ascending date.
export function mergeDailyRows(
  weather: readonly DailyWeatherRow[],
  air: readonly DailyWeatherRow[]
): DailyWeatherRow[] {
  const byDate = new Map<string, DailyWeatherRow>();
  for (const w of weather) byDate.set(w.date, { ...emptyDay(w.date), ...w });
  for (const a of air) {
    const row = byDate.get(a.date) ?? emptyDay(a.date);
    row.aqi = a.aqi;
    row.pollenTree = a.pollenTree;
    row.pollenGrass = a.pollenGrass;
    row.pollenWeed = a.pollenWeed;
    byDate.set(a.date, row);
  }
  return [...byDate.keys()].sort().map((d) => byDate.get(d)!);
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

// A JSON GET with the shared timeout, returning the parsed body or a failure. Never
// throws — every weather fetch degrades rather than breaking the sync.
async function getJson(
  url: string
): Promise<
  { ok: true; json: unknown } | { ok: false; status: number; error?: string }
> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, json: await res.json() };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// The DAILY network touch: the weather endpoint (forecast vs. archive by date, the same
// chooseEndpoint rule the hourly fetch uses) merged with the air-quality endpoint.
//
// The two halves fail INDEPENDENTLY. A weather failure fails the request (there is
// nothing left to cache). An air-quality failure does NOT: the temperature/pressure
// rows are the load-bearing half, so the result comes back ok with `partial` set and
// simply carries no AQI/pollen — the pollen and air-quality predicates then have no
// data and stay silent, which is exactly the intended degradation. No key, no auth.
export async function openMeteoFetchDaily(
  lat: number,
  lng: number,
  startDate: string,
  endDate: string,
  timezone: string
): Promise<DailyFetchResult> {
  const endpoint = chooseEndpoint(endDate, todayUtc());
  const base = endpoint === "archive" ? ARCHIVE_BASE : FORECAST_BASE;
  const weatherQs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    daily: DAILY_VARS.join(","),
    hourly: DAILY_HOURLY_VARS.join(","),
    timezone,
    start_date: startDate,
    end_date: endDate,
  });
  const weather = await getJson(`${base}?${weatherQs.toString()}`);
  if (!weather.ok) {
    return {
      ok: false,
      rows: [],
      status: weather.status,
      error: weather.error,
    };
  }
  const weatherRows = parseOpenMeteoDaily(weather.json);

  const airQs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: AIR_QUALITY_VARS.join(","),
    timezone,
    start_date: startDate,
    end_date: endDate,
  });
  const air = await getJson(`${AIR_QUALITY_BASE}?${airQs.toString()}`);
  if (!air.ok) {
    return {
      ok: true,
      rows: weatherRows,
      partial: air.error ?? `air-quality fetch failed (${air.status})`,
    };
  }
  return {
    ok: true,
    rows: mergeDailyRows(weatherRows, parseOpenMeteoAirQuality(air.json)),
  };
}

// The default source: Open-Meteo. Swap this (or inject another WeatherSource into
// runWeatherSync) to change providers.
export const openMeteoSource: WeatherSource = {
  id: "open-meteo",
  fetchHourly: openMeteoFetch,
  fetchDaily: openMeteoFetchDaily,
};
