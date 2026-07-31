// The light-exposure line's DB assembly (#1723 part 1). Auth-blind, profileId-first.
//
// It only gathers: the already-synced weather/UV cache for the profile's home
// location, the solar day, the relevance gate, and the tracked practice's pace. The
// decision — is today favorable, and what does the line say — lives in the pure
// lib/light-exposure.ts, so every conditions scenario is a fixture rather than a
// weather fixture.

import { getHomeLocation, getTimezone } from "../settings";
import { solarDay } from "../sun";
import { daylightWindow } from "../daylight";
import { getUvHoursForDay } from "../integrations/weather-cache";
import { getWeatherDays } from "../integrations/weather-cache";
import {
  FAVORABLE_MIN_UV,
  lightExposureLine,
  type LightExposureLineInput,
} from "../light-exposure";
import { getFrequencyTargetProgress } from "./frequency-targets";
import { getDaylightOutdoorMinutesTotal } from "./sun";
import { lastNDates } from "../date";
import { practiceIdentity } from "../practice";

// The practices this line is relevant to. Matched on the practice's own identity
// (case/whitespace-folded, the ONE practice identity — never a synonym fold), plus a
// narrow keyword test so a user's own "Sunlight walk" counts without needing to be in
// the starter list.
const LIGHT_PRACTICE_IDENTITIES = new Set([
  practiceIdentity("Morning light exposure"),
]);

function isLightPractice(scopeValue: string): boolean {
  if (LIGHT_PRACTICE_IDENTITIES.has(practiceIdentity(scopeValue))) return true;
  return /\b(light|sun|sunlight|daylight|outdoor)\b/i.test(scopeValue);
}

// How far back the "sun card is active" test looks for logged daylight-outdoor time.
const SUN_CARD_LOOKBACK_DAYS = 30;

// RELEVANCE, not blanket (#1723). The line appears only for a profile this is
// actually about: one that TRACKS a light/outdoor practice, or one whose sun surface
// is live (a home location plus real logged daylight-outdoor time — the concrete form
// of "has the sun card active"). Everyone else gets nothing, on every kind of day.
export function lightExposureRelevant(
  profileId: number,
  date: string
): boolean {
  const tracksPractice = getFrequencyTargetProgress(profileId).some(
    (p) =>
      p.target.scope_kind === "practice" &&
      isLightPractice(p.target.scope_value)
  );
  if (tracksPractice) return true;
  if (!getHomeLocation(profileId)) return false;
  return (
    getDaylightOutdoorMinutesTotal(
      profileId,
      lastNDates(date, SUN_CARD_LOOKBACK_DAYS)
    ) > 0
  );
}

// The pace clause, from the SHARED frequency-target progress (#221) — the same
// `pace`/`count`/`per_week` the Wellness card and the practice nudge render. Only a
// BEHIND target speaks: an on-pace practice needs no mention, and a met one certainly
// does not.
function lightPracticePacePhrase(profileId: number): string | null {
  for (const p of getFrequencyTargetProgress(profileId)) {
    if (p.target.scope_kind !== "practice") continue;
    if (!isLightPractice(p.target.scope_value)) continue;
    if (p.met || p.atCeiling || p.pace !== "behind") continue;
    return `${p.target.scope_value} is ${p.count}/${p.per_week} this week`;
  }
  return null;
}

// The digest's Today light line for `date`, or null. Null covers every quiet case:
// no home location (sun features off), no cached forecast, an unfavorable day, and a
// profile the line isn't relevant to.
export function getLightExposureLine(
  profileId: number,
  date: string
): string | null {
  const home = getHomeLocation(profileId);
  if (!home) return null;
  if (!lightExposureRelevant(profileId, date)) return null;

  const day = getWeatherDays(home.lat, home.lng, date, date)[0];
  if (!day) return null;

  const timezone = getTimezone(profileId);
  const solar = solarDay(home.lat, home.lng, date, timezone);
  const hasDaylight = daylightWindow(solar) != null;

  // The window's close: the last cached local hour still carrying usable UV. Absent
  // hourly data simply drops the "until" clause — the line never invents a time.
  let windowEndHour: number | null = null;
  for (const h of getUvHoursForDay(home.lat, home.lng, date)) {
    if (h.uvIndex == null || h.uvIndex < FAVORABLE_MIN_UV) continue;
    const m = /T(\d{2}):/.exec(h.hourTs);
    if (!m) continue;
    const hour = Number(m[1]);
    if (
      Number.isFinite(hour) &&
      (windowEndHour == null || hour > windowEndHour)
    )
      windowEndHour = hour;
  }

  const input: LightExposureLineInput = {
    weatherCode: day.weatherCode,
    precipitationMm: day.precipitationMm,
    uvIndexMax: day.uvIndexMax,
    hasDaylight,
    windowEndHour,
    pacePhrase: lightPracticePacePhrase(profileId),
  };
  return lightExposureLine(input);
}
