// Pure solar-position core (issue #570) — the NOAA sunrise/sunset algorithm, no
// dependency. From (lat, lng, calendar date, timezone) it yields sunrise, sunset,
// solar noon, day length, and the sun's elevation at any instant. Everything that
// touches "where am I in the day" (daylight chips, daylight-outdoor-minutes,
// sun-exposure protocols) formats THIS one computation — "one question, one
// computation". No external service: a coarse home location + this math is all it
// needs, so sun features stay fully offline.
//
// The trig is the standard NOAA Solar Calculator
// (https://gml.noaa.gov/grad/solcalc/). The low-level functions take an explicit
// numeric UTC offset in hours so they're deterministic and unit-testable without a
// timezone database; solarDay() resolves the offset from an IANA timezone via Intl
// (deterministic given the date, no clock/network — safe for the pure test tier).

import { timezoneOffsetMinutes } from "./timezone";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// Julian day at 0h UT for a Gregorian calendar date (ends in .5).
function julianDay0(y: number, m: number, d: number): number {
  let yy = y;
  let mm = m;
  if (mm <= 2) {
    yy -= 1;
    mm += 12;
  }
  const A = Math.floor(yy / 100);
  const B = 2 - A + Math.floor(A / 4);
  return (
    Math.floor(365.25 * (yy + 4716)) +
    Math.floor(30.6001 * (mm + 1)) +
    d +
    B -
    1524.5
  );
}

interface SolarGeometry {
  declRad: number; // solar declination (radians)
  eqTimeMin: number; // equation of time (minutes)
}

// Solar declination + equation of time for a Julian century T.
function solarGeometry(T: number): SolarGeometry {
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mrad = M * DEG;
  const C =
    Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const eps0 =
    23 +
    (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG);
  const epsRad = eps * DEG;
  const declRad = Math.asin(Math.sin(epsRad) * Math.sin(lambda * DEG));

  const yTan = Math.tan(epsRad / 2) ** 2;
  const L0rad = L0 * DEG;
  const eqTimeMin =
    4 *
    RAD *
    (yTan * Math.sin(2 * L0rad) -
      2 * e * Math.sin(Mrad) +
      4 * e * yTan * Math.sin(Mrad) * Math.cos(2 * L0rad) -
      0.5 * yTan * yTan * Math.sin(4 * L0rad) -
      1.25 * e * e * Math.sin(2 * Mrad));
  return { declRad, eqTimeMin };
}

function mod360(x: number): number {
  return ((x % 360) + 360) % 360;
}

export interface SunTimes {
  // Minutes past local midnight (in the given tz), or null on a polar day/night.
  sunriseMin: number | null;
  sunsetMin: number | null;
  // Solar noon, always defined (minutes past local midnight).
  solarNoonMin: number;
  // Daylight length in minutes (0 on polar night, 1440 on polar day).
  dayLengthMin: number;
  // "day" = sun never sets (24h daylight), "night" = never rises, null otherwise.
  polar: "day" | "night" | null;
}

// The official zenith for sunrise/sunset: 90.833° accounts for atmospheric
// refraction (~0.567°) plus the sun's apparent radius (~0.267°).
const SUNRISE_ZENITH = 90.833;

// Sunrise/sunset/solar-noon for a calendar date at (lat, lng), given the location's
// UTC offset in hours on that date (east-positive lng, north-positive lat). Pure and
// offset-explicit so it's testable without a timezone database.
export function sunTimes(
  lat: number,
  lng: number,
  y: number,
  m: number,
  d: number,
  tzOffsetHours: number
): SunTimes {
  // Evaluate the geometry at local solar noon (accurate to seconds for a day view).
  const jdNoon = julianDay0(y, m, d) + (12 - tzOffsetHours) / 24;
  const T = (jdNoon - 2451545) / 36525;
  const { declRad, eqTimeMin } = solarGeometry(T);

  // Solar noon in minutes past local midnight: 720 − 4·lng − EqTime + tzOffset·60.
  const solarNoonMin = 720 - 4 * lng - eqTimeMin + tzOffsetHours * 60;

  const latRad = lat * DEG;
  const cosH =
    Math.cos(SUNRISE_ZENITH * DEG) / (Math.cos(latRad) * Math.cos(declRad)) -
    Math.tan(latRad) * Math.tan(declRad);

  if (cosH < -1) {
    // Sun never sets — polar day.
    return {
      sunriseMin: null,
      sunsetMin: null,
      solarNoonMin,
      dayLengthMin: 1440,
      polar: "day",
    };
  }
  if (cosH > 1) {
    // Sun never rises — polar night.
    return {
      sunriseMin: null,
      sunsetMin: null,
      solarNoonMin,
      dayLengthMin: 0,
      polar: "night",
    };
  }
  const haMin = 4 * RAD * Math.acos(cosH); // hour-angle half-width, minutes
  const sunriseMin = solarNoonMin - haMin;
  const sunsetMin = solarNoonMin + haMin;
  return {
    sunriseMin,
    sunsetMin,
    solarNoonMin,
    dayLengthMin: 2 * haMin,
    polar: null,
  };
}

// The sun's elevation (degrees above the horizon; negative below) at (lat, lng) at
// `minutesPastMidnight` local time on the date, given the UTC offset. Pure.
export function solarElevation(
  lat: number,
  lng: number,
  y: number,
  m: number,
  d: number,
  tzOffsetHours: number,
  minutesPastMidnight: number
): number {
  const jd =
    julianDay0(y, m, d) + (minutesPastMidnight / 60 - tzOffsetHours) / 24;
  const T = (jd - 2451545) / 36525;
  const { declRad, eqTimeMin } = solarGeometry(T);
  // True solar time (minutes): local time + EqTime + 4·lng − tzOffset·60.
  const trueSolarMin =
    minutesPastMidnight + eqTimeMin + 4 * lng - tzOffsetHours * 60;
  // Hour angle (degrees): 0 at solar noon, ±180 at midnight.
  let ha = trueSolarMin / 4 - 180;
  if (ha < -180) ha += 360;
  const latRad = lat * DEG;
  const cosZenith =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(ha * DEG);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) * RAD;
}

// Format minutes-past-midnight as "HH:MM" (24h), wrapping into [0, 1440) so a
// sunrise pushed just past midnight by an extreme longitude still reads sanely.
export function formatMinutes(min: number | null): string | null {
  if (min == null || !Number.isFinite(min)) return null;
  let mm = Math.round(min) % 1440;
  if (mm < 0) mm += 1440;
  const h = Math.floor(mm / 60);
  const m = mm % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// The UTC offset (hours, east-positive; e.g. -7 for America/Los_Angeles in summer)
// for an IANA timezone on a given calendar date, DST-aware. Uses Intl (deterministic
// given the inputs — no clock/network). Returns null for an invalid timezone.
export function tzOffsetHours(
  timezone: string,
  y: number,
  m: number,
  d: number
): number | null {
  // Compute the offset at local noon so a DST-transition day resolves cleanly.
  const at = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const minutes = timezoneOffsetMinutes(timezone, at);
  return minutes === null ? null : minutes / 60;
}

export interface SolarDay {
  date: string; // YYYY-MM-DD (the input date)
  sunrise: string | null; // "HH:MM" local, or null on a polar day/night
  sunset: string | null;
  solarNoon: string;
  dayLengthMin: number;
  polar: "day" | "night" | null;
  // The daylight window in minutes past local midnight, for intersection math
  // (daylight-outdoor-minutes). null endpoints on a polar night (empty window);
  // on a polar day the whole [0, 1440] counts.
  sunriseMin: number | null;
  sunsetMin: number | null;
}

// The one high-level entry point: the solar day for a coarse home location + an
// IANA timezone. Returns null when the timezone can't be resolved (sun features
// then quietly stay absent — the degrade-gracefully pattern). `date` is "YYYY-MM-DD".
export function solarDay(
  lat: number,
  lng: number,
  date: string,
  timezone: string
): SolarDay | null {
  const mch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!mch) return null;
  const y = Number(mch[1]);
  const m = Number(mch[2]);
  const d = Number(mch[3]);
  const off = tzOffsetHours(timezone, y, m, d);
  if (off == null) return null;
  const t = sunTimes(lat, lng, y, m, d, off);
  return {
    date,
    sunrise: formatMinutes(t.sunriseMin),
    sunset: formatMinutes(t.sunsetMin),
    solarNoon: formatMinutes(t.solarNoonMin)!,
    dayLengthMin: Math.round(t.dayLengthMin),
    polar: t.polar,
    sunriseMin: t.sunriseMin,
    sunsetMin: t.sunsetMin,
  };
}
