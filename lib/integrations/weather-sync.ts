import { createLogger } from "@/lib/log";
import { userErrorCopy } from "@/lib/user-error-copy";
import { getHomeLocation } from "@/lib/settings";
import { getTimezone } from "@/lib/settings";
import { WEATHER_ID, recordSync, recordSyncEvent } from "./connections";
import { syncFailureCopy, syncFailureKind } from "./auth-failure";
import { openMeteoSource, type WeatherSource } from "./open-meteo";
import { upsertUvHours, upsertWeatherDays } from "./weather-cache";
import {
  summarizeSplit,
  type UpsertCounts,
  emptyCounts,
  foldCounts,
} from "./sync-log";
import { truncatedSyncDetails } from "./sync-details";

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

// The host this module reaches for, named as #3592 already named it in
// open-meteo.ts's throw branch ("Couldn't reach Open-Meteo. Try again."), so both
// halves of the same failure speak of the same thing.
const SOURCE_NAME = "Open-Meteo";

// How many trailing days to (re-)fetch each run. Covers recent logged days for the
// backfill and keeps the archive/forecast window bounded. Idempotent, so re-fetching
// the overlap is free.
export const WEATHER_WINDOW_DAYS = 14;

// How far AHEAD to fetch. The hourly UV window ends a day past today (enough for the
// current local day's dose); the DAILY window reaches further because the forecast is
// itself an input — the outdoor-viability scan (#1724) plans against the coming week.
// Kept at the honest reliable horizon: Open-Meteo publishes 16 days, but nothing in the
// app commits to a day beyond WEATHER_FORECAST_DAYS.
//
// This is the horizon of the WEATHER endpoint only. The air-quality endpoint has its
// own, shorter ceiling (AIR_QUALITY_FORECAST_DAYS in ./open-meteo — 7 days COUNTING
// today, i.e. today + 6), and the source clamps its own request to it. Sending this
// window to both was #3007: every air-quality request was one day out of range.
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

// The Review line for a weather run whose DAILY half failed (#2567). It names the
// half that failed and what is missing, because the shared default line names a page
// cap or a rate limit — neither of which is what happened here — and says the next
// sync picks up where it left off, which for a rolling re-fetch means nothing.
// Exported so its test asserts the copy rather than a paraphrase of it.
//
// The TAIL depends on which KIND of failure it was (#3007). "The next run re-fetches
// it" was written for #2567's load-shedding case, where the next run genuinely does
// fix it — and it was then printed, hourly and forever, over a deterministic 400 that
// had never once succeeded and never would. A 4xx says so instead.
export function weatherPartialWarning(
  reason: string,
  options: { deterministic?: boolean } = {}
): string {
  const tail = options.deterministic
    ? "the next run asks the same thing and gets the same answer, so this stays missing until it's fixed."
    : "the next run re-fetches it.";
  return `Partial sync — the hourly UV series was cached, but the daily forecast/air-quality half failed (${reason}). Pollen, AQI and daily conditions are absent for this window; ${tail}`;
}

// A response status that will answer the same way next time. 4xx is the request being
// wrong (a bad parameter, an out-of-range window); 5xx and 0 (network error/timeout)
// are the ones a retry can clear.
export function isDeterministicFailure(status: number | undefined): boolean {
  return status != null && status >= 400 && status < 500;
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
// FIELD-WISE, through the shared fold rather than a hand-written sum: a segment added
// to UpsertCounts (`superseded`, #3424) must reach every split that reports one, and a
// literal here would have silently dropped it while still compiling.
function mergeCounts(a: UpsertCounts, b: UpsertCounts): UpsertCounts {
  return foldCounts([a, b]);
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
    // The hourly half's failure IS the run's failure, so this string is the one the
    // integration card, the "Sync now" toast and the morning digest all show (#3618).
    // `res.error` is already the house sentence when the request THREW; a rejection
    // gets one from the shared vocabulary. Weather never reaches the reconnect
    // sentence at all: that one is written by the pull RUNNER off a connection row,
    // and a keyless source has neither.
    const error =
      res.error ??
      syncFailureCopy(SOURCE_NAME, syncFailureKind(res.status ?? 0));
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
    // The UV cache write refused (a constraint, a locked DB). Its SQLite vocabulary
    // is for an operator; the card and the "Sync now" toast get the house
    // sentence (#3592).
    log.error("weather UV upsert failed", {
      profile: profileId,
      err: err instanceof Error ? err.message : String(err),
    });
    const message = userErrorCopy(err, { doing: "save the UV forecast" });
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
  // Whether the partial above will recur identically on the next run (#3007) — it
  // decides the warning's tail, and only a response status can answer it.
  let partialDeterministic = false;
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
    partialDeterministic = isDeterministicFailure(daily.status);
  } else {
    partial = daily.partial;
    partialDeterministic = isDeterministicFailure(daily.partialStatus);
    try {
      dayCounts = upsertWeatherDays(home.lat, home.lng, daily.rows, source.id);
    } catch (err) {
      // A write failure, not a response — a retry is exactly the right advice.
      //
      // THE REASON IS A FRAGMENT, NOT A SENTENCE (#3592). It is interpolated into
      // weatherPartialWarning's parenthetical beside "air-quality fetch failed
      // (400)", so the shape that belongs here is an authored clause in that
      // register — not `userErrorCopy`'s standalone "Couldn't … Try again.", whose
      // retry advice would then contradict the warning's own tail. The raw cause,
      // which is SQLite vocabulary, goes to the log like every other write failure.
      log.error("weather daily upsert failed", {
        profile: profileId,
        err: err instanceof Error ? err.message : String(err),
      });
      partial = "the daily rows couldn't be saved";
      partialDeterministic = false;
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
    // THE DEGRADED RUN, RECORDED (#2567). `partial` was computed here, folded into the
    // returned summary and logged — and then this event was written WITHOUT it, so a
    // run whose daily/air-quality half failed stored `ok: true`, no details, no error,
    // and nothing anywhere said it was degraded. The only trace was `received`
    // silently dropping; 2 of the 80 successes in a twelve-day window had been
    // degraded that way, invisibly.
    //
    // The standing already existed and already rendered: `isTruncatedSyncEvent` reads
    // this marker, `scheduledStanding` returns "partial" off it, and Strava, Oura and
    // Withings share the serializer. This run computed the input for all of it and
    // dropped it on the floor. It writes it now, through the shared shape with its own
    // honest line rather than a fourth spelling of the same fact.
    details: partial
      ? truncatedSyncDetails(
          weatherPartialWarning(partial, {
            deterministic: partialDeterministic,
          })
        )
      : null,
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
