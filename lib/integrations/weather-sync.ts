import { createLogger } from "@/lib/log";
import { getHomeLocation } from "@/lib/settings";
import { getTimezone } from "@/lib/settings";
import { WEATHER_ID, recordSync, recordSyncEvent } from "./connections";
import { openMeteoSource, type WeatherSource } from "./open-meteo";
import { upsertUvHours } from "./weather-cache";
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

export interface WeatherSyncResult {
  hours: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

function shiftDate(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Sync the profile's home-location UV series. Returns a summary, or { error } for a
// graceful failure (no home location, provider/network error) — never throws for those.
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
      windowEnd: endDate,
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
      windowEnd: endDate,
      error: message,
    });
    return { error: message };
  }

  const total = counts.inserted + counts.updated + counts.unchanged;
  const summary: WeatherSyncResult = {
    hours: total,
    inserted: counts.inserted,
    updated: counts.updated,
    unchanged: counts.unchanged,
  };
  recordSync(profileId, WEATHER_ID, { hours: total });
  const tally = summarizeSplit(counts, 0);
  recordSyncEvent(profileId, WEATHER_ID, {
    ok: true,
    windowStart: startDate,
    windowEnd: endDate,
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
