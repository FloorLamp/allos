// The daylight-outdoor-minutes read layer (issue #571). This is the ONE place the
// "how much daylight-outdoor time did I log?" question is computed against the DB;
// every surface (timeline chip, coaching observation, and a future protocol input)
// formats THIS result — "one question, one computation", so a second engine can't
// drift from it. The pure intersection math lives in lib/daylight; the solar window
// in lib/sun; this only assembles the inputs (home location, timezone, outdoor
// activities) and hands them over.

import { db } from "@/lib/db";
import { getHomeLocation, getTimezone } from "@/lib/settings";
import { solarDay } from "@/lib/sun";
import { daylightOutdoorMinutes, type DaylightActivity } from "@/lib/daylight";

// Daylight-outdoor minutes for each of `dates` (YYYY-MM-DD), as a Map date→minutes.
// A day with no home location, no outdoor activity, or an unresolvable solar window
// contributes 0 (it simply won't appear, or appears as 0). "Outdoor" is the
// persisted signal `avg_temp_c IS NOT NULL` (a temperature is only recorded by an
// outdoor GPS device) OR a captured GPS route — either makes the session explicitly
// outdoors. Profile-scoped (activities.profile_id). Returns an empty map when the
// profile has no home location (sun features quietly off).
export function getDaylightOutdoorMinutesByDay(
  profileId: number,
  dates: string[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (dates.length === 0) return out;
  const home = getHomeLocation(profileId);
  if (!home) return out;
  const timezone = getTimezone(profileId);

  const placeholders = dates.map(() => "?").join(",");
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
    .all(profileId, ...dates) as {
    date: string;
    start_time: string | null;
    end_time: string | null;
  }[];

  const byDate = new Map<string, DaylightActivity[]>();
  for (const r of rows) {
    const arr = byDate.get(r.date) ?? [];
    arr.push({ startTime: r.start_time, endTime: r.end_time, outdoor: true });
    byDate.set(r.date, arr);
  }

  for (const [date, acts] of byDate) {
    const day = solarDay(home.lat, home.lng, date, timezone);
    const min = daylightOutdoorMinutes(acts, day);
    if (min > 0) out.set(date, min);
  }
  return out;
}

// Total daylight-outdoor minutes across `dates` — the window sum the coaching
// observation averages. Convenience over getDaylightOutdoorMinutesByDay.
export function getDaylightOutdoorMinutesTotal(
  profileId: number,
  dates: string[]
): number {
  let total = 0;
  for (const m of getDaylightOutdoorMinutesByDay(profileId, dates).values())
    total += m;
  return total;
}
