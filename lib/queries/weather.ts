// The UV-dose read layer (issue #1172): the ONE place the "how much UV dose did I get
// outdoors?" question is answered against the DB. Every surface (the sun-exposure
// protocol, the DaylightChip UV badge, the overexposure care finding, the outdoor-time
// chart) formats THIS result — "one question, one computation" (#221), so a second
// engine can't drift. The pure crossing math is lib/uv-dose (computeUvDose); the solar
// geometry is lib/sun; the cached series is weather-cache; this only assembles the
// inputs and applies the DEGRADATION LADDER (live → clear-sky → minutes-only).

import { db } from "@/lib/db";
import { getHomeLocation, getTimezone } from "@/lib/settings";
import { getSkinType } from "@/lib/settings";
import { solarDay, solarElevation, tzOffsetHours } from "@/lib/sun";
import { daylightWindow, hhmmToMin } from "@/lib/daylight";
import {
  getUvHoursForDays,
  type CachedUvHour,
} from "@/lib/integrations/weather-cache";
import {
  computeUvDose,
  elevationUvCeiling,
  type UvDoseResult,
  type UvSource,
} from "@/lib/uv-dose";

// The local hour (0..23) of a cached "YYYY-MM-DDTHH:00" timestamp.
function hourOf(hourTs: string): number | null {
  const m = /T(\d{2}):/.exec(hourTs);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

interface UvWindow {
  startMin: number;
  endMin: number;
}

// The daylight-clipped OUTDOOR windows for a profile across a SET of dates (local
// minutes past midnight), the same "outdoor" signal (avg_temp_c present OR a captured
// route) and the same daylight intersection lib/queries/sun uses — so the dose crosses
// exactly the #571 daylight-outdoor time. Profile-scoped (activities.profile_id).
//
// ONE widened read over the whole set (#2113), the shape
// getDaylightOutdoorMinutesByDay already uses one module over: the solar window is the
// only per-date input, and it is pure geometry.
function outdoorWindowsForDays(
  profileId: number,
  dates: readonly string[],
  lat: number,
  lng: number,
  timezone: string
): Map<string, UvWindow[]> {
  const out = new Map<string, UvWindow[]>();
  const wanted = [...new Set(dates)];
  if (wanted.length === 0) return out;

  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.date, a.start_time, a.end_time
         FROM activities a
        WHERE a.profile_id = ?
          AND a.date IN (${placeholders})
          AND a.start_time IS NOT NULL AND a.end_time IS NOT NULL
          AND (a.avg_temp_c IS NOT NULL
               OR EXISTS (SELECT 1 FROM activity_routes r WHERE r.activity_id = a.id))`
    )
    .all(profileId, ...wanted) as {
    date: string;
    start_time: string | null;
    end_time: string | null;
  }[];

  const winByDate = new Map<string, { start: number; end: number } | null>();
  for (const r of rows) {
    let win = winByDate.get(r.date);
    if (win === undefined) {
      win = daylightWindow(solarDay(lat, lng, r.date, timezone));
      winByDate.set(r.date, win);
    }
    if (!win) continue;
    const start = hhmmToMin(r.start_time);
    const end = hhmmToMin(r.end_time);
    if (start == null || end == null || end <= start) continue;
    const clipStart = Math.max(start, win.start);
    const clipEnd = Math.min(end, win.end);
    if (clipEnd <= clipStart) continue;
    const list = out.get(r.date) ?? [];
    list.push({ startMin: clipStart, endMin: clipEnd });
    out.set(r.date, list);
  }
  return out;
}

// The dose for ONE date, over inputs the caller already gathered. Pure assembly — no
// DB reads — so the single-date and the whole-feed entry points below run byte-identical
// math (#221: one question, one computation).
function uvDoseFromInputs(
  date: string,
  windows: UvWindow[],
  cached: CachedUvHour[],
  home: { lat: number; lng: number },
  timezone: string,
  skinType: ReturnType<typeof getSkinType>
): UvDoseResult {
  // No outdoor daylight time → a zero-minute dose (still resolve the source so callers
  // can render "0 min outdoors" consistently).
  const liveByHour = new Map<number, number>();
  const clearSkyByHour = new Map<number, number>();
  for (const c of cached) {
    const h = hourOf(c.hourTs);
    if (h == null) continue;
    if (c.uvIndex != null) liveByHour.set(h, c.uvIndex);
    if (c.uvIndexClearSky != null) clearSkyByHour.set(h, c.uvIndexClearSky);
  }

  // Which hours the outdoor windows actually touch — the ladder is decided over these.
  const touchedHours = new Set<number>();
  for (const w of windows) {
    const first = Math.floor(w.startMin / 60);
    const last = Math.floor((w.endMin - 1) / 60);
    for (let h = first; h <= last; h++) touchedHours.add(h);
  }

  // sun.ts elevation-based clear-sky ceiling (the fully-offline rung) at each hour's
  // mid-point — used when neither a live nor a provider clear-sky value is cached.
  const off = tzOffsetHours(
    timezone,
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)),
    Number(date.slice(8, 10))
  );
  const elevationUv = (h: number): number => {
    if (off == null) return 0;
    const elev = solarElevation(
      home.lat,
      home.lng,
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)),
      Number(date.slice(8, 10)),
      off,
      h * 60 + 30
    );
    return elevationUvCeiling(elev);
  };

  // Degradation ladder, decided over the touched outdoor hours: prefer live cached UV;
  // else provider clear-sky; else the sun.ts elevation ceiling. With a home location we
  // can ALWAYS produce at least the elevation estimate, so the provenance is "live" when
  // any touched hour carries live UV, otherwise "clear-sky" (never "none" here — the
  // minutes-only "none" rung is reachable only without a home location, which returns
  // null above).
  const hourlyUv = new Map<number, number>();
  let anyLive = false;
  for (const h of touchedHours) {
    if (liveByHour.has(h)) {
      hourlyUv.set(h, liveByHour.get(h)!);
      anyLive = true;
    } else if (clearSkyByHour.has(h)) {
      hourlyUv.set(h, clearSkyByHour.get(h)!);
    } else {
      hourlyUv.set(h, elevationUv(h));
    }
  }
  const uvSource: UvSource = anyLive ? "live" : "clear-sky";

  return computeUvDose({ windows, hourlyUv, uvSource, skinType });
}

// The UV-dose result for a profile on a date, or null when the feature is OFF (no home
// location — sun features quietly absent, the #570 degrade-gracefully pattern). When a
// home location is set, the degradation ladder always yields at least a clear-sky
// estimate from sun.ts geometry, so the dose is defined even fully offline.
export function getUvDoseForDay(
  profileId: number,
  date: string
): UvDoseResult | null {
  return getUvDoseForDays(profileId, [date]).get(date) ?? null;
}

// The same answer for every date in a SET, in a FIXED number of statements (#2113):
// home location, timezone and skin type are profile facts that do not vary by date, and
// the activities + cached-UV reads are each widened over the whole set. The Timeline
// renders a UV chip per day, and asking the single-date accessor inside that loop cost
// ~4 statements per rendered day on the second-most-visited page.
//
// An empty Map when the profile has no home location — every date is absent, which the
// single-date reader above turns back into its `null`. Otherwise EVERY requested date
// carries an entry, including days with no outdoor time (a zero-minute dose), exactly
// as the per-day read did.
export function getUvDoseForDays(
  profileId: number,
  dates: readonly string[]
): Map<string, UvDoseResult> {
  const out = new Map<string, UvDoseResult>();
  const wanted = [...new Set(dates)];
  if (wanted.length === 0) return out;
  const home = getHomeLocation(profileId);
  if (!home) return out;
  const timezone = getTimezone(profileId);
  const skinType = getSkinType(profileId);
  const windowsByDate = outdoorWindowsForDays(
    profileId,
    wanted,
    home.lat,
    home.lng,
    timezone
  );
  const cachedByDate = getUvHoursForDays(home.lat, home.lng, wanted);
  for (const date of wanted) {
    out.set(
      date,
      uvDoseFromInputs(
        date,
        windowsByDate.get(date) ?? [],
        cachedByDate.get(date) ?? [],
        home,
        timezone,
        skinType
      )
    );
  }
  return out;
}
