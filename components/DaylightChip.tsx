import { IconSunrise, IconSunset } from "@tabler/icons-react";
import { solarDay } from "@/lib/sun";
import type { HomeLocation } from "@/lib/home-location";

// Sunrise/sunset daylight chips for a day (issue #570), computed from the profile's
// coarse home location + timezone via the pure lib/sun core — no external service.
// Renders NOTHING when there's no home location (sun features quietly stay off — the
// degrade-gracefully pattern), so callers can drop it in unconditionally.
//
// Server-safe (a pure formatter over solarDay). `date` is "YYYY-MM-DD".
export default function DaylightChip({
  home,
  date,
  timezone,
  outdoorMinutes = 0,
}: {
  home: HomeLocation | null | undefined;
  date: string;
  timezone: string;
  // Daylight-outdoor minutes logged that day (issue #571) — the SAME
  // getDaylightOutdoorMinutesByDay computation the coaching observation averages.
  // 0 → the "outdoors" line is omitted.
  outdoorMinutes?: number;
}) {
  if (!home) return null;
  const day = solarDay(home.lat, home.lng, date, timezone);
  if (!day) return null;
  const outdoors =
    outdoorMinutes > 0 ? (
      <span
        data-testid="daylight-outdoor-minutes"
        className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400"
      >
        ☀ {outdoorMinutes} min outdoors
      </span>
    ) : null;

  if (day.polar === "day" || day.polar === "night") {
    return (
      <div
        data-testid="daylight-chip"
        className="mt-1 text-xs text-slate-500 dark:text-slate-400"
      >
        {day.polar === "day" ? "☀ Midnight sun (24h daylight)" : "Polar night"}
      </div>
    );
  }
  if (!day.sunrise || !day.sunset) return null;
  return (
    <div
      data-testid="daylight-chip"
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400"
    >
      <span className="inline-flex items-center gap-1">
        <IconSunrise className="h-3.5 w-3.5 shrink-0" stroke={1.75} />
        {day.sunrise}
      </span>
      <span className="inline-flex items-center gap-1">
        <IconSunset className="h-3.5 w-3.5 shrink-0" stroke={1.75} />
        {day.sunset}
      </span>
      {outdoors}
    </div>
  );
}
