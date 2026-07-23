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
import { getUvHoursForDay } from "@/lib/integrations/weather-cache";
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

// The daylight-clipped OUTDOOR windows for a profile on a date (local minutes past
// midnight), the same "outdoor" signal (avg_temp_c present OR a captured route) and the
// same daylight intersection lib/queries/sun uses — so the dose crosses exactly the
// #571 daylight-outdoor time. Profile-scoped (activities.profile_id).
function outdoorWindowsForDay(
  profileId: number,
  date: string,
  lat: number,
  lng: number,
  timezone: string
): { windows: { startMin: number; endMin: number }[] } {
  const day = solarDay(lat, lng, date, timezone);
  const win = daylightWindow(day);
  if (!win) return { windows: [] };

  const rows = db
    .prepare(
      `SELECT a.start_time, a.end_time
         FROM activities a
        WHERE a.profile_id = ?
          AND a.date = ?
          AND a.start_time IS NOT NULL AND a.end_time IS NOT NULL
          AND (a.avg_temp_c IS NOT NULL
               OR EXISTS (SELECT 1 FROM activity_routes r WHERE r.activity_id = a.id))`
    )
    .all(profileId, date) as {
    start_time: string | null;
    end_time: string | null;
  }[];

  const windows: { startMin: number; endMin: number }[] = [];
  for (const r of rows) {
    const start = hhmmToMin(r.start_time);
    const end = hhmmToMin(r.end_time);
    if (start == null || end == null || end <= start) continue;
    const clipStart = Math.max(start, win.start);
    const clipEnd = Math.min(end, win.end);
    if (clipEnd > clipStart)
      windows.push({ startMin: clipStart, endMin: clipEnd });
  }
  return { windows };
}

// The UV-dose result for a profile on a date, or null when the feature is OFF (no home
// location — sun features quietly absent, the #570 degrade-gracefully pattern). When a
// home location is set, the degradation ladder always yields at least a clear-sky
// estimate from sun.ts geometry, so the dose is defined even fully offline.
export function getUvDoseForDay(
  profileId: number,
  date: string
): UvDoseResult | null {
  const home = getHomeLocation(profileId);
  if (!home) return null;
  const timezone = getTimezone(profileId);
  const { windows } = outdoorWindowsForDay(
    profileId,
    date,
    home.lat,
    home.lng,
    timezone
  );
  const skinType = getSkinType(profileId);

  // No outdoor daylight time → a zero-minute dose (still resolve the source so callers
  // can render "0 min outdoors" consistently).
  const cached = getUvHoursForDay(home.lat, home.lng, date);
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
