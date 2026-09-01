// The Open-Meteo weather/UV adapter (issue #1172). Open-Meteo is the recommended
// source for this app's self-hosted, offline-leaning, NO-ACCOUNT posture: no API key,
// both signals in one API (hourly uv_index AND shortwave/direct/diffuse irradiance in
// W/m²), a FREE historical archive (ERA5) that lets us backfill the UV for already-
// logged outdoor minutes, and uv_index_clear_sky alongside actual UV (the degradation
// ladder's clear-sky rung, as a field). The source sits behind the small WeatherSource
// interface so the source is SWAPPABLE (an OpenWeatherMap adapter, or a self-hosted
// Open-Meteo, drops in without touching the sync/cache/dose layers) — default is
// Open-Meteo.
//
// Split: the PURE parse (parseOpenMeteoHourly) is unit-tested with fixtures; the fetch
// (openMeteoFetch) is the only network touch and is injected into the sync so tests run
// fully offline. Coordinates handed here are already the coarse (~0.1°/~11 km) home
// location — nothing sharper ever reaches an outbound request.

import { createLogger } from "@/lib/log";
import { userErrorCopy } from "@/lib/user-error-copy";

const log = createLogger("open-meteo");

// One hour of the cached series (local wall-clock hour for the location's timezone, so
// it crosses directly with the local-time daylight/activity windows). Any field may be
// null when the source omits it for that hour.
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

// What a source returns for the DAILY request. Same graceful-failure shape, as a UNION
// rather than a bag of optionals: a failure ALWAYS carries the line the sync shows and
// the status it judges recurrence by, so the sync needs no fallback branch — and the
// one it used to have printed a status code on the card (#3639).
export type DailyFetchResult =
  | {
      ok: true;
      rows: DailyWeatherRow[];
      // Set when the weather half succeeded but the air-quality half did not: the rows
      // are still usable (temperature/pressure predicates work), pollen/AQI are simply
      // absent. A partial is NOT a sync failure — it degrades, it does not fail (the
      // graceful-degradation posture the whole weather feature is built on).
      partial?: string;
      // The HTTP status behind `partial`, when there was one (0 = network error/
      // timeout, absent = the partial came from somewhere other than a response). The
      // sync reads it to tell a DETERMINISTIC failure from a transient one: a 4xx
      // fails identically next run, so promising a re-fetch would be false (#3007).
      // Never rendered (#3639).
      partialStatus?: number;
    }
  | {
      ok: false;
      rows: DailyWeatherRow[];
      status: number;
      error: string;
    };

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

// How far ahead the AIR-QUALITY host publishes — NOT the same horizon as the weather
// forecast host, which is what #3007 was. The weather endpoint publishes 16 days; air
// quality publishes 7, and its "7 days" COUNTS TODAY, so the last `end_date` it
// accepts is today + 6. The daily sync asks both endpoints for one window
// (WEATHER_FORECAST_DAYS = today + 7, in ./weather-sync — the horizon the
// outdoor-viability scan genuinely needs), so every air-quality request was exactly
// one day out of range and came back 400:
//
//   Parameter 'end_date' is out of allowed range from 2013-01-01 to <today+6>
//
// deterministically, on every run since the daily half shipped. An air-quality failure
// degrades rather than breaking (see openMeteoFetchDaily), so nothing ever said the
// AQI/pollen half had not once succeeded.
//
// Kept here rather than beside WEATHER_FORECAST_DAYS because it is a property of THIS
// host, not of what the app wants: a different source would have a different ceiling,
// and weather-sync already imports this module (the reverse would be a cycle).
export const AIR_QUALITY_FORECAST_DAYS = 7;

// The air-quality request's end date: the caller's window end CLAMPED to this host's
// ceiling. A clamp, never an assignment — a window that ends BEFORE the ceiling (an
// archival backfill) keeps its own end and is never widened. Pure and exported so the
// boundary is unit-testable without a network call.
export function airQualityEndDate(endDate: string, today: string): string {
  const ceiling = shiftDate(today, AIR_QUALITY_FORECAST_DAYS - 1);
  return endDate < ceiling ? endDate : ceiling;
}

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
// shape, so ONE parser covers both. Rows come back in the source's order (ascending
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

// Which pollen FAMILY each source species belongs to. Family grain is the domain
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
// of a body carrying only one of the two blocks. Rows come back in source order
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
    if (!res.ok) {
      // NO `error` FIELD, SINCE #3618. The hourly half's failure IS the run's
      // failure, so whatever went here was the line the integration card, the
      // "Sync now" toast and the morning digest all showed a person — and
      // "weather fetch failed (503)" named a status and asked for nothing. The
      // status travels instead, and weather-sync turns it into a sentence.
      //
      // #3007's point survives: the host's own explanation of a rejection is
      // exactly what an operator needs, so it goes to the log rather than being
      // discarded. (The air-quality half still renders it — that line is a
      // partial-run warning in Review, not a person's failure sentence.)
      log.error("weather hourly fetch rejected", {
        endpoint,
        status: res.status,
        reason: await failureReason(res),
      });
      return { ok: false, rows: [], status: res.status };
    }
    const rows = parseOpenMeteoHourly(await res.json());
    return { ok: true, rows };
  } catch (err) {
    // A network throw (DNS, TLS, the timeout above). THIS `error` IS THE RUN'S
    // FAILURE LINE — weather-sync writes it to `integration_sync_events.error`, the
    // integration card renders it in red, and the "Sync now" toast shows it as
    // written. So the raw cause goes to the log and the column gets the house
    // sentence (#3592).
    log.error("weather hourly fetch failed", {
      endpoint,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      rows: [],
      status: 0,
      error: userErrorCopy(err, {
        doing: "refresh the weather forecast",
        service: "Open-Meteo",
      }),
    };
  }
}

// How much of a rejected response's body to keep. Long enough for the vendor's
// sentence, short enough that a stray HTML error page can't fill a sync event.
const REASON_MAX_CHARS = 200;

// How much of a rejected response's body to READ. The cap above bounds what is
// STORED; this one bounds what crosses into memory to produce it. `res.text()`
// buffers the WHOLE body first, so a 64 MB error page behind a 502 cost 64 MB of
// heap to yield 200 characters — on a path that read no body at all before #3007.
// Well past any real vendor error body (Open-Meteo's is a couple of hundred bytes),
// so the JSON parse below still sees a complete document.
const REASON_MAX_READ_CHARS = 4_096;

// Read at most REASON_MAX_READ_CHARS of a body and abandon the rest. Falls back to
// text() only for a response with no stream at all (a synthesized one).
async function readCappedBody(res: Response): Promise<string> {
  const stream = res.body;
  if (!stream) return (await res.text()).slice(0, REASON_MAX_READ_CHARS);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < REASON_MAX_READ_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Whether we stopped early or reached the end, nothing else wants this body.
    void reader.cancel().catch(() => {});
  }
  return text.slice(0, REASON_MAX_READ_CHARS);
}

// The request URI carries the profile's home coordinates, and a rejected request's
// text travels into integration_sync_events.details AND — because the pull tick
// spreads each runner's result into log.info — into the operator log on every
// hourly tick. Home location is PHI-adjacent and must NEVER be written to any log
// (lib/settings/location.ts).
//
// Open-Meteo is not necessarily what answers: a proxy or captive portal in front of
// it replies with its own error page, and those quote the URI they could not
// forward. So the RAW-body fallback is scrubbed before it is kept.
//
// WHAT IT DROPS: a `latitude`/`longitude` parameter with its value, in every
// spelling a middlebox writes one (query parameter, percent-encoded, JSON field,
// wrapped across a line); an `http(s)://…` URI; and a bare number left sitting
// where such a URI was cut.
//
// WHAT IT DOES NOT: a coordinate whose KEY is gone. Written as prose — "for
// location 40.7, -74.0" — or with a line break falling INSIDE the key itself, there
// is nothing to match on, and no pattern can tell those numbers from any other pair.
// That residue is accepted, not overlooked: it is bounded by the coordinates being
// roundCoord-coarse (~0.1°, ~11 km) before they ever leave this process, which is
// why this is a second line of defence rather than the first — nothing sharper is
// ever in the request to begin with.
//
// The JSON `reason` path is deliberately NOT scrubbed. Open-Meteo echoes a
// parameter only when that parameter is invalid, and an out-of-range coordinate
// cannot reach the request: getHomeLocation re-runs normalizeHome on every READ, so
// `home_lat = '999'` planted straight into profile_settings yields null and
// runWeatherSync returns "no home location" before any fetch happens. The sentence
// #3007 needed is the whole point of this fallback, so it travels intact.
//
// That is a DEPENDENCY, not an observation about the vendor. The JSON path is
// trusted because a stored home cannot be out of range — not because Open-Meteo
// never quotes a coordinate, which it does when the coordinate is invalid. If
// normalizeHome ever loosens its range check, this decision has to be revisited.

// One parameter, several spellings. Folding them to a single spelling BEFORE
// matching is what keeps this from being three patterns that drift apart: a
// percent-encoded echo is not `latitude=` and a JSON field is not `latitude=`, but
// both are the same key bound to the same value. Only the URI delimiters are
// decoded — never the whole body, which would invent characters nobody sent.
function foldSpellings(text: string): string {
  return (
    text
      // The three QUERY-STRING delimiters, and only those: what binds a key to its
      // value. Decoding the scheme and path separators too would tidy the leftover
      // host text and close no leak, so it is not done.
      .replace(/%3F/gi, "?")
      .replace(/%3D/gi, "=")
      .replace(/%26/gi, "&")
      // A JSON field is the same key/value pair with a different separator.
      .replace(/"([^"\r\n]{1,64})"\s*:/g, "$1=")
  );
}

// `latitude=40.7`, after the fold. `\s*` around the `=` so a URI wrapped across a
// line still binds its value to its key. The value class ends at whitespace, `&`, a
// quote, a comma or a semicolon — without those last three, a MINIFIED JSON body
// offers no terminator after the final parameter and the match runs to the end of
// the document, taking the vendor's sentence with it.
const COORD_PARAM = /[?&]?\b(?:latitude|longitude)\s*=\s*"?[^\s&"',;]*/gi;

// Whatever is left of the URI itself, plus a number immediately adjacent to it. The
// trailing number is the wrap hazard approached from the other side: a value that
// ended up beside a URI whose key did not survive the break goes with the URI.
const URL_IN_TEXT = /https?:\/\/[^\s"']*(?:\s*[-+]?\d[\d.]*)?/gi;

// The parameter strip runs FIRST, and that ordering is the primary defence for a
// wrapped URI: a URL strip running first consumes the trailing `…?latitude=` and
// leaves the bare value with no key for the parameter strip to find — the pattern
// meant to protect the coordinate becomes the thing that exposes it. That is not a
// hypothetical; it is what this module did before the ordering was fixed.
//
// Stated plainly, because it is the kind of thing a later reader should not have to
// re-derive: with `\s*` allowed around the `=`, the ordering ALONE handles every
// wrap shape under test, and the numeric tail of URL_IN_TEXT alone handles them too.
// The redundancy is deliberate — they fail differently, and the failure mode is a
// coordinate in an operator log — but neither is currently the only thing standing
// between a wrapped URI and a leak.
//
// The parameter strip closes its gap rather than leaving a space, so a URI it cut a
// parameter out of stays one contiguous token for the URL strip behind it. Replacing
// with a space instead splits the URI and strands the tail of its query string
// (`&hourly=us_aqi`) in the middle of the sentence.
function stripLocation(text: string): string {
  return foldSpellings(text)
    .replace(COORD_PARAM, "")
    .replace(URL_IN_TEXT, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// What the vendor SAID about a rejected request. Open-Meteo answers a bad request
// with `{"error":true,"reason":"Parameter 'end_date' is out of allowed range from
// 2013-01-01 to 2026-08-22"}` — one sentence that names the parameter, the rule and
// the current ceiling. Discarding it (#3007) is why eight production runs recorded
// only a bare status and the cause needed a hand-run curl. A horizon that moves again
// should say so on its own.
//
// IT GOES TO `log.error`, NEVER TO A SURFACE (#3639): it is a diagnosis, and the card
// is for the person whose pollen data is missing.
//
// The read is bounded (REASON_MAX_READ_CHARS) and the raw fallback is scrubbed of the
// home location (stripLocation) — see both above. That scrub is load-bearing for the
// log destination as much as it was for the card: home location must never be written
// to any log (lib/settings/location.ts).
async function failureReason(res: Response): Promise<string | undefined> {
  let body: string;
  try {
    body = (await readCappedBody(res)).trim();
  } catch {
    return undefined; // a body that won't read is not worth failing over
  }
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const reason =
      parsed && typeof parsed === "object"
        ? (parsed as { reason?: unknown }).reason
        : undefined;
    if (typeof reason === "string" && reason.trim())
      return reason.trim().slice(0, REASON_MAX_CHARS);
  } catch {
    // Not JSON (a gateway's HTML page, say) — the raw body is still better than
    // nothing, capped the same way and with the location stripped out of it.
  }
  return stripLocation(body).slice(0, REASON_MAX_CHARS) || undefined;
}

// What a failed half says ON A PERSON'S SURFACE — FRAGMENTS, because
// `weatherPartialWarning` interpolates them beside "the daily forecast/air-quality
// half failed (…)", the register the write half's "the daily rows couldn't be saved"
// already uses.
//
// NO STATUS AND NO UPSTREAM BODY (#3639): both used to be interpolated here and both
// rendered on the card. The status still TRAVELS — `partialStatus` decides whether the
// warning promises a re-fetch — it is simply never printed. Hence one line per half
// and no branch on it: a refusal, a 5xx and a timeout are one thing to the reader, and
// the only distinction they can act on is the warning's own tail.
const AIR_QUALITY_FAILURE_LINE = "the air-quality data didn't come back";
const DAILY_FAILURE_LINE = "the daily forecast didn't come back";

// A JSON GET with the shared timeout, returning the parsed body or a failure. Never
// throws — every weather fetch degrades rather than breaking the sync.
//
// A REJECTION IS DIAGNOSED IN THE LOG AND NOWHERE ELSE (#3639): the status and the
// host's explanation are written here, and only the status travels back, for the
// recurrence question. The hourly half already worked this way (#3618).
async function getJson(
  label: string,
  url: string
): Promise<{ ok: true; json: unknown } | { ok: false; status: number }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      log.error(`${label} rejected`, {
        status: res.status,
        reason: await failureReason(res),
      });
      return { ok: false, status: res.status };
    }
    return { ok: true, json: await res.json() };
  } catch (err) {
    // NO `error` FIELD ANY MORE (#3592). It used to carry the throw's own text, and
    // that text was interpolated straight into weatherPartialWarning's parenthetical
    // and rendered in Data → Review — "the daily forecast/air-quality half failed
    // (fetch failed)". The cause goes to the log; the caller's fetchFailureLine
    // names the half and says "no response", which is what a reader can use.
    log.error(`${label} failed`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, status: 0 };
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
  const today = todayUtc();
  const endpoint = chooseEndpoint(endDate, today);
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
  const weather = await getJson(
    "daily fetch",
    `${base}?${weatherQs.toString()}`
  );
  if (!weather.ok) {
    return {
      ok: false,
      rows: [],
      status: weather.status,
      // Same rule as the air half: the person is told which half is missing, and the
      // status and the host's sentence stay in the log getJson just wrote.
      error: DAILY_FAILURE_LINE,
    };
  }
  const weatherRows = parseOpenMeteoDaily(weather.json);

  const airQs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: AIR_QUALITY_VARS.join(","),
    timezone,
    start_date: startDate,
    // The two endpoints DO NOT share a horizon (#3007). The weather half keeps the
    // caller's window; the air-quality half is clamped to its own shorter ceiling,
    // which is the whole reason this request stopped being a guaranteed 400.
    end_date: airQualityEndDate(endDate, today),
  });
  const air = await getJson(
    "air-quality fetch",
    `${AIR_QUALITY_BASE}?${airQs.toString()}`
  );
  if (!air.ok) {
    return {
      ok: true,
      rows: weatherRows,
      partial: AIR_QUALITY_FAILURE_LINE,
      partialStatus: air.status,
    };
  }
  return {
    ok: true,
    rows: mergeDailyRows(weatherRows, parseOpenMeteoAirQuality(air.json)),
  };
}

// The default source: Open-Meteo. Swap this (or inject another WeatherSource into
// runWeatherSync) to change sources.
export const openMeteoSource: WeatherSource = {
  id: "open-meteo",
  fetchHourly: openMeteoFetch,
  fetchDaily: openMeteoFetchDaily,
};
