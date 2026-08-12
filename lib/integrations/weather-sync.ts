import { createLogger } from "@/lib/log";
import { getHomeLocation } from "@/lib/settings";
import { getTimezone } from "@/lib/settings";
import { WEATHER_ID, recordSync, recordSyncEvent } from "./connections";
import { openMeteoSource, type WeatherSource } from "./open-meteo";
import { upsertUvHours, upsertWeatherDays } from "./weather-cache";
import { summarizeSplit, type UpsertCounts, emptyCounts } from "./sync-log";

// Pulls the hourly UV + irradiance series for a profile's HOME LOCATION from Open-Meteo
// and upserts it into the GLOBAL, location-keyed cache (weather_uv_hours). Runs from
// both the "Sync now" server action and the hourly notify tick, so — like the other
// syncs — it must NOT touch any Next.js request-scoped API (callers revalidate). It is
// keyless (Open-Meteo needs no account) and idempotent: the cache upsert dedups on
// (location, hour) and a re-fetch of the same window rewrites nothing (the sync
// invariant, docs/internals/integrations-sync.md). One integration_sync_events row is
// appended per run with the insert/update/unchanged split, under the acting profile.
//
// It fetches a trailing window ending TODAY so a logged past day's outdoor UV is
// backfilled from the free historical archive (the load-bearing #1172 requirement — the
// dose model crosses PAST outdoor minutes with the UV that actually occurred). The
// WeatherSource is injected (defaulting to Open-Meteo) so tests run fully offline.

const log = createLogger("weather-sync");

// How many trailing days to (re-)fetch each run. Covers recent logged days for the
// backfill and keeps the archive/forecast window bounded. Idempotent, so re-fetching
// the overlap is free.
export const WEATHER_WINDOW_DAYS = 14;

// How far AHEAD to fetch. The hourly UV window ends a day past today (enough for the
// current local day's dose); the DAILY window reaches further because the forecast is
// itself an input — the outdoor-viability scan (#1724) plans against the coming week.
// Kept at the honest reliable horizon: Open-Meteo publishes 16 days, but nothing in the
// app commits to a day beyond WEATHER_FORECAST_DAYS.
export const WEATHER_FORECAST_DAYS = 7;

export interface WeatherSyncResult {
  hours: number;
  // Daily rows written/seen this run (the #1726 substrate).
  days: number;
  inserted: number;
  updated: number;
  unchanged: number;
  // Set when the daily fetch's air-quality half failed: the run still SUCCEEDED and
  // cached temperature/pressure; pollen/AQI are simply absent for this window.
  partial?: string;
}

function shiftDate(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// One run's two upsert halves (hourly UV + daily aggregates) as a single split, so the
// integration_sync_events row reports ONE honest insert/update/unchanged accounting for
// the run rather than two partial ones.
function mergeCounts(a: UpsertCounts, b: UpsertCounts): UpsertCounts {
  return {
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    suppressed: a.suppressed + b.suppressed,
    edited: a.edited + b.edited,
  };
}

// Sync the profile's home-location UV series. Returns a summary, or { error } for a
// graceful failure (no home location, source/network error) — never throws for those.
export async function runWeatherSync(
  profileId: number,
  source: WeatherSource = openMeteoSource
): Promise<WeatherSyncResult | { error: string }> {
  const home = getHomeLocation(profileId);
  // No home location → the feature is simply off for this profile (degrade gracefully).
  if (!home) return { error: "no home location" };

  const timezone = getTimezone(profileId);
  const today = todayUtc();
  const startDate = shiftDate(today, -(WEATHER_WINDOW_DAYS - 1));
  // End a day past today so the forecast endpoint covers the whole current local day.
  const endDate = shiftDate(today, 1);
  // The DAILY half reaches further (below). Computed HERE, before the first fetch,
  // because it is also the run's stamped window: every event this run records —
  // success or failure — describes the window the RUN SET OUT TO COVER, not the half
  // that happened to finish (#1771). Stamping an hourly-fetch failure with the hourly
  // half's shorter reach made interleaved events of one source describe two
  // different window shapes, which read in Review as if a failure had shrunk the
  // coverage target.
  const dailyEnd = shiftDate(today, WEATHER_FORECAST_DAYS);

  const res = await source.fetchHourly(
    home.lat,
    home.lng,
    startDate,
    endDate,
    timezone
  );
  if (!res.ok) {
    const error =
      res.error ?? `weather fetch failed (${res.status ?? "unknown"})`;
    recordSyncEvent(profileId, WEATHER_ID, {
      ok: false,
      windowStart: startDate,
      windowEnd: dailyEnd,
      error,
    });
    return { error };
  }

  let counts: UpsertCounts = emptyCounts();
  try {
    counts = upsertUvHours(home.lat, home.lng, res.rows, source.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSyncEvent(profileId, WEATHER_ID, {
      ok: false,
      windowStart: startDate,
      windowEnd: dailyEnd,
      error: message,
    });
    return { error: message };
  }

  // ---- The DAILY half (#1726) ----
  // Same window start (so a logged past day gets its conditions backfilled from the
  // archive) but reaching WEATHER_FORECAST_DAYS ahead, because the forecast half of the
  // series is itself an input to the planning surfaces. Its failure does NOT fail the
  // run: the hourly UV series is already cached and the whole feature family degrades
  // rather than breaking (the derived situations simply have no data and stay silent).
  let dayCounts: UpsertCounts = emptyCounts();
  let partial: string | undefined;
  const daily = await source.fetchDaily(
    home.lat,
    home.lng,
    startDate,
    dailyEnd,
    timezone
  );
  if (!daily.ok) {
    partial =
      daily.error ?? `daily fetch failed (${daily.status ?? "unknown"})`;
  } else {
    partial = daily.partial;
    try {
      dayCounts = upsertWeatherDays(home.lat, home.lng, daily.rows, source.id);
    } catch (err) {
      partial = err instanceof Error ? err.message : String(err);
    }
  }

  const total = counts.inserted + counts.updated + counts.unchanged;
  const dayTotal = dayCounts.inserted + dayCounts.updated + dayCounts.unchanged;
  const summary: WeatherSyncResult = {
    hours: total,
    days: dayTotal,
    // The event's accounting covers BOTH halves — one sync run, one insert/update/
    // unchanged split, per the integrations rules.
    inserted: counts.inserted + dayCounts.inserted,
    updated: counts.updated + dayCounts.updated,
    unchanged: counts.unchanged + dayCounts.unchanged,
    ...(partial ? { partial } : {}),
  };
  recordSync(profileId, WEATHER_ID, { hours: total, days: dayTotal });
  const tally = summarizeSplit(mergeCounts(counts, dayCounts), 0);
  recordSyncEvent(profileId, WEATHER_ID, {
    ok: true,
    windowStart: startDate,
    windowEnd: dailyEnd,
    received: tally.received,
    written: tally.inserted + tally.updated + tally.unchanged,
    inserted: tally.inserted,
    updated: tally.updated,
    unchanged: tally.unchanged,
    suppressed: tally.suppressed,
    edited: tally.edited,
    skipped: tally.skipped,
  });
  log.info("weather sync", { profile: profileId, ...summary });
  return summary;
}
