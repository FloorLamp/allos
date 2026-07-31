// The weather-aware light-exposure line (#1723 part 1) — PURE. No DB, no clock, no
// network, so every conditions scenario is a fixture.
//
// WHAT THIS IS. Weather and UV already sync (`open-meteo`, `runWeatherSync`) but power
// only the OVEREXPOSURE warning: nothing conditions-aware has ever said "today is a
// good day to get outside". This adds one line to the morning digest's Today section
// when — and only when — the forecast actually supports it.
//
// WHAT THIS IS NOT. It is not a send: it rides the digest that already goes out (the
// owner decision recorded in #1723 and consistent with #1713's UV ruling). It is not
// an instruction with a deadline: the phrasing STATES A WINDOW ("UV moderate until
// 4pm — good window for light exposure"), because "get outside by 4pm" is an
// obligation the user never declared, and the system may not invent one.
//
// The gate is what makes it signal rather than filler. `favorableLightConditions` is
// the named predicate: clear or partly-clear skies, effectively dry, and a real
// daylight window carrying usable-but-not-punishing UV. Rain, overcast, missing data
// and a scorching UV day all produce NO LINE — the quiet-day rule.

import { weatherCodeLabel } from "./weather-training";

// The condition labels that count as favorable. Read from the SAME weatherCodeLabel
// mapping the conditions stamps use (#1728) rather than a second WMO-code table, so a
// code that reads "partly cloudy" on an activity stamp reads the same way here.
export const FAVORABLE_CONDITION_LABELS: readonly string[] = [
  "clear",
  "partly cloudy",
];

// Effectively dry. A trace (drizzle that never landed) should not veto a clear day,
// but any real precipitation total should.
export const FAVORABLE_MAX_PRECIP_MM = 1;

// The UV band the line is willing to describe. Below the floor there is no meaningful
// light to speak of (a midwinter overcast noon); at or above the ceiling the day
// belongs to the overexposure engine (#1172), not to an encouragement line — the two
// must never both speak about one afternoon.
export const FAVORABLE_MIN_UV = 1;
export const FAVORABLE_MAX_UV = 8;

export interface LightConditionsInput {
  // The day's WMO weather-interpretation code, or null when nothing is cached.
  weatherCode: number | null;
  // The day's total precipitation in mm, or null when unknown.
  precipitationMm: number | null;
  // The day's peak UV index, or null when unknown.
  uvIndexMax: number | null;
  // Whether a real daylight window exists for the location/date (the solar day
  // resolved). A polar night has none.
  hasDaylight: boolean;
}

// THE named gate. Every clause is a veto: absent data is never favorable (silence
// beats a guess), and a day outside the UV band is left to the engines that own it.
export function favorableLightConditions(input: LightConditionsInput): boolean {
  if (!input.hasDaylight) return false;
  const label = weatherCodeLabel(input.weatherCode);
  if (label == null || !FAVORABLE_CONDITION_LABELS.includes(label))
    return false;
  if (
    input.precipitationMm != null &&
    input.precipitationMm > FAVORABLE_MAX_PRECIP_MM
  )
    return false;
  const uv = input.uvIndexMax;
  if (uv == null) return false;
  return uv >= FAVORABLE_MIN_UV && uv < FAVORABLE_MAX_UV;
}

// The WHO UV-index bands, named so the copy states the band rather than a bare number
// (a "UV 4" line asks the reader to know the scale; "UV moderate" does not).
export function uvBandLabel(uv: number | null): string | null {
  if (uv == null || !Number.isFinite(uv)) return null;
  if (uv < 3) return "low";
  if (uv < 6) return "moderate";
  if (uv < 8) return "high";
  if (uv < 11) return "very high";
  return "extreme";
}

// "4pm" / "11am" from a local hour (0..23).
export function hourClockLabel(hour: number): string {
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  const suffix = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${suffix}`;
}

export interface LightExposureLineInput extends LightConditionsInput {
  // The last local hour whose UV is still in the usable band — the window's close.
  // Null when the hourly series isn't cached; the line then omits the "until" clause
  // rather than inventing one.
  windowEndHour: number | null;
  // The tracked light practice's pace clause, already formatted by the SHARED
  // frequencyPace formatter (#221) — "Morning light is 2/5 this week" — or null when
  // the practice isn't tracked or isn't behind. Never re-derived here.
  pacePhrase?: string | null;
}

// The rendered line, or null when the day isn't favorable. Deliberately one sentence,
// stating conditions and a window, with the optional pace clause appended.
export function lightExposureLine(
  input: LightExposureLineInput
): string | null {
  if (!favorableLightConditions(input)) return null;
  const condition = weatherCodeLabel(input.weatherCode);
  const band = uvBandLabel(input.uvIndexMax);
  const opener = condition === "clear" ? "Sunny" : "Partly sunny";
  const until =
    input.windowEndHour != null
      ? ` until ${hourClockLabel(input.windowEndHour)}`
      : "";
  const uvClause = band ? `, UV ${band}${until}` : until ? `,${until}` : "";
  const pace = input.pacePhrase ? ` — ${input.pacePhrase}` : "";
  return `${opener}${uvClause} — good window for light exposure${pace}.`;
}
