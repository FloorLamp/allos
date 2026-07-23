import { IconSunrise, IconSunset } from "@tabler/icons-react";
import { solarDay } from "@/lib/sun";
import type { HomeLocation } from "@/lib/home-location";

// Sunrise/sunset daylight chips for a day (issue #570), computed from the profile's
// coarse home location + timezone via the pure lib/sun core — no external service.
// Renders NOTHING when there's no home location (sun features quietly stay off — the
// degrade-gracefully pattern), so callers can drop it in unconditionally.
//
// Server-safe (a pure formatter over solarDay). `date` is "YYYY-MM-DD".
// A day's UV enrichment (issue #1172): the LIVE UV summary from the ONE UV-dose
// computation (getUvDoseForDay). Passed only when actual measured UV is available for
// the day's outdoor window; absent → the chip degrades to minutes-only (offline / no
// integration), preserving #570's offline guarantee.
export interface DaylightUv {
  uvMinutes: number | null;
  peakUvIndex: number | null;
}

export default function DaylightChip({
  home,
  date,
  timezone,
  outdoorMinutes = 0,
  uv = null,
}: {
  home: HomeLocation | null | undefined;
  date: string;
  timezone: string;
  // Daylight-outdoor minutes logged that day (issue #571) — the SAME
  // getDaylightOutdoorMinutesByDay computation the coaching observation averages.
  // 0 → the "outdoors" line is omitted.
  outdoorMinutes?: number;
  // Live UV enrichment for the day's outdoor window (#1172), or null to degrade to
  // minutes-only. The caller only passes this when the source is measured/live.
  uv?: DaylightUv | null;
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
  const uvBadge =
    uv && uv.peakUvIndex != null && uv.peakUvIndex > 0 ? (
      <span
        data-testid="daylight-uv"
        className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"
        title="Peak UV index during your outdoor window"
      >
        UV {Math.round(uv.peakUvIndex)}
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
      {uvBadge}
    </div>
  );
}
