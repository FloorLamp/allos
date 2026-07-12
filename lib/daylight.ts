// The ONE pure computation for "daylight outdoor minutes" (issue #570 groundwork,
// #571 metric): intersect an activity's time window with the day's daylight window.
// Every surface that shows daylight-outdoor-minutes (timeline chip, protocol input,
// coaching observation) formats THIS result — "one question, one computation", so a
// second engine can never drift from it.
//
// Pure (no DB/clock) — takes already-loaded activity windows + a SolarDay.

import type { SolarDay } from "./sun";

// Parse an "HH:MM" wall-clock string to minutes past midnight, or null.
export function hhmmToMin(hhmm: string | null | undefined): number | null {
  if (typeof hhmm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Overlap (minutes) of two closed intervals [aStart,aEnd] and [bStart,bEnd], clamped
// at 0. Both are minutes past midnight on the same day.
export function overlapMinutes(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// The daylight window [start, end] in minutes for a SolarDay: the sunrise→sunset
// span, the whole day on a polar day, or an empty window on a polar night. null when
// the day has no resolvable window.
export function daylightWindow(
  day: SolarDay | null
): { start: number; end: number } | null {
  if (!day) return null;
  if (day.polar === "day") return { start: 0, end: 1440 };
  if (day.polar === "night") return { start: 0, end: 0 };
  if (day.sunriseMin == null || day.sunsetMin == null) return null;
  return { start: day.sunriseMin, end: day.sunsetMin };
}

// An activity's time window for the intersection: start/end as "HH:MM" and whether
// it was OUTDOORS. Outdoor-ness is the persisted `avg_temp_c != null` signal (a temp
// is only recorded by an outdoor GPS device) or, more explicitly, a captured route.
export interface DaylightActivity {
  startTime: string | null;
  endTime: string | null;
  outdoor: boolean;
}

// Daylight-outdoor minutes for ONE activity against a SolarDay: 0 unless it's
// outdoor, has both a start and end time, and overlaps the daylight window.
export function activityDaylightMinutes(
  a: DaylightActivity,
  day: SolarDay | null
): number {
  if (!a.outdoor) return 0;
  const start = hhmmToMin(a.startTime);
  const end = hhmmToMin(a.endTime);
  if (start == null || end == null || end <= start) return 0;
  const win = daylightWindow(day);
  if (!win) return 0;
  return Math.round(overlapMinutes(start, end, win.start, win.end));
}

// Total daylight-outdoor minutes across a day's activities. The metric every surface
// formats (#571). SolarDay is the same day the activities fall on.
export function daylightOutdoorMinutes(
  activities: DaylightActivity[],
  day: SolarDay | null
): number {
  let total = 0;
  for (const a of activities) total += activityDaylightMinutes(a, day);
  return total;
}
