// Weather-aware training recommendations (issue #1724) — the PURE core. Given a
// profile's own logged outdoor sessions joined to the weather that actually occurred on
// those days, plus today's (or the week's) conditions, decide which outdoor activities
// are PARKED, say why, and name the indoor stand-in.
//
// THE CENTRAL RULE: TOLERANCE IS REVEALED, NEVER ASSUMED. The app does not get to
// decide that 3 °C is too cold to ride. A profile with rides logged at 3 °C is a
// profile that rides at 3 °C, and parking their bike would be the engine overruling
// evidence with a guess. So the envelope is derived from the SESSIONS THEMSELVES —
// the conditions this person has actually trained in — and the named constants are
// only the fallback for a profile whose history is too thin to reveal anything yet.
// This is the revealed-preference family (#1670) with the crucial difference that
// NOTHING IS WRITTEN OR SUGGESTED: the envelope only orders today's pick.
//
// The engine also never BANS. Parking is the #838 de-rank-with-disclosure shape: the
// outdoor activity drops out of today's suggestion, the message says why, the mapped
// indoor alternative takes its slot — and logging the outdoor session anyway remains
// entirely normal and, because the envelope is derived from logs, TEACHES THE ENGINE.
//
// BUCKETED AND STABLE (#1490). The envelope's bounds are quantiles of the observed
// distribution, not its extremes, so one heroic session in a blizzard doesn't move
// them; and they are rounded to a bucket so a new session nudges the answer in steps
// rather than continuously.
//
// Pure — no DB, no clock. The gather is lib/queries/weather-training.ts.

import { indoorAlternatives, isOutdoorActivity } from "./activities-catalog";
import { shiftDateStr } from "./date";
import { fmtAmbientTemp, type WeatherDay } from "./weather-situations";
import type { TemperatureUnit } from "./settings";

// ---- Named constants (adjust-in-review) -------------------------------------------

// How many of a profile's own sessions (with weather coverage) are needed before the
// envelope is REVEALED rather than assumed. Below this the fallback constants apply —
// and they are deliberately permissive, because the failure mode of a too-tight guess
// (parking something the person happily does) is worse than of a too-loose one.
export const MIN_REVEALED_SESSIONS = 6;

// The quantile the revealed bounds sit at. The coldest 10% and wettest 10% of the
// sessions someone has actually done are treated as the edge of their tolerance, not
// its centre — generous, so the engine parks only conditions genuinely outside their
// demonstrated range, and robust, so a single outlier session can't set the bound.
export const ENVELOPE_QUANTILE = 0.1;

// Bucket sizes the revealed bounds round to (#1490): the answer moves in steps.
export const TEMP_BUCKET_C = 2;
export const PRECIP_BUCKET_MM = 2;

// How far OUTSIDE the revealed bound conditions must fall before the activity is
// parked. A margin, not a cliff: someone whose coldest ride was 4 °C is not parked at
// 3 °C, because the bound is an observation, not a declaration.
export const PARK_TEMP_MARGIN_C = 3;
export const PARK_PRECIP_MARGIN_MM = 3;

// The FALLBACK envelope for a profile with too little history — conservative in the
// permissive direction. Only genuinely hostile conditions park an activity here.
export const FALLBACK_MIN_TEMP_C = -5;
export const FALLBACK_MAX_TEMP_C = 35;
export const FALLBACK_MAX_PRECIP_MM = 10;

// How far ahead the planning scan will look. Beyond the reliable forecast horizon the
// line hedges or stays silent rather than committing to next Wednesday's sunshine.
export const FORECAST_HORIZON_DAYS = 5;

// ---- Inputs -----------------------------------------------------------------------

// One logged session joined to the weather of its day — the SHARED join (#1724's
// envelope input and #1728's display stamp are the same row, built once in the query
// layer and consumed by both).
export interface SessionWeather {
  date: string;
  activity: string;
  tempMaxC: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
}

// The conditions envelope an activity is done in, per activity. `revealed` says whether
// it came from the profile's own sessions or from the fallback constants — the
// disclosure copy is honest about which.
export interface ToleranceEnvelope {
  activity: string;
  revealed: boolean;
  sessionCount: number;
  minTempC: number;
  maxTempC: number;
  maxPrecipitationMm: number;
}

// ---- Deriving the envelope --------------------------------------------------------

// The value at `q` through a sorted numeric list (nearest-rank). Small lists are the
// normal case here, so exactness beats interpolation subtleties.
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(q * (sorted.length - 1)))
  );
  return sorted[idx];
}

function floorTo(value: number, bucket: number): number {
  return Math.floor(value / bucket) * bucket;
}

function ceilTo(value: number, bucket: number): number {
  return Math.ceil(value / bucket) * bucket;
}

// The fallback envelope — what the engine assumes when it has not been shown anything.
export function fallbackEnvelope(activity: string): ToleranceEnvelope {
  return {
    activity,
    revealed: false,
    sessionCount: 0,
    minTempC: FALLBACK_MIN_TEMP_C,
    maxTempC: FALLBACK_MAX_TEMP_C,
    maxPrecipitationMm: FALLBACK_MAX_PRECIP_MM,
  };
}

// Derive one activity's envelope from the profile's own sessions. Sessions WITHOUT
// weather coverage are ignored (they reveal nothing); when fewer than
// MIN_REVEALED_SESSIONS remain, the fallback applies. The bounds are quantiles, then
// bucketed outward, so the envelope is stable against a single outlier and moves in
// steps as seasons accumulate.
export function deriveEnvelope(
  activity: string,
  sessions: readonly SessionWeather[]
): ToleranceEnvelope {
  const mine = sessions.filter(
    (s) => sameActivity(s.activity, activity) && s.tempMaxC != null
  );
  if (mine.length < MIN_REVEALED_SESSIONS) return fallbackEnvelope(activity);

  const temps = mine.map((s) => s.tempMaxC as number).sort((a, b) => a - b);
  const precip = mine
    .map((s) => s.precipitationMm)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  // Bucket OUTWARD on both ends, so bucketing can only ever widen the person's
  // demonstrated range — never narrow it into parking something they've done.
  const minTempC = floorTo(quantile(temps, ENVELOPE_QUANTILE), TEMP_BUCKET_C);
  const maxTempC = ceilTo(
    quantile(temps, 1 - ENVELOPE_QUANTILE),
    TEMP_BUCKET_C
  );
  const maxPrecipitationMm =
    precip.length > 0
      ? Math.max(
          FALLBACK_MAX_PRECIP_MM,
          ceilTo(quantile(precip, 1 - ENVELOPE_QUANTILE), PRECIP_BUCKET_MM)
        )
      : FALLBACK_MAX_PRECIP_MM;

  return {
    activity,
    revealed: true,
    sessionCount: mine.length,
    minTempC,
    maxTempC,
    maxPrecipitationMm,
  };
}

// Activity identity, case/space-folded — the one comparison every consumer uses.
export function sameActivity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Every outdoor activity's envelope, keyed by the folded name.
export function deriveEnvelopes(
  activities: readonly string[],
  sessions: readonly SessionWeather[]
): Map<string, ToleranceEnvelope> {
  const out = new Map<string, ToleranceEnvelope>();
  for (const a of activities) {
    if (!isOutdoorActivity(a)) continue;
    out.set(a.trim().toLowerCase(), deriveEnvelope(a, sessions));
  }
  return out;
}

// ---- The parked decision ----------------------------------------------------------

// Why an activity is parked — the fact the disclosure names. Never prose here; the
// formatter owns the copy so every surface phrases it identically.
export type ParkReason = "cold" | "hot" | "wet";

// WHAT THE REASON'S VALUE MEASURES (issue #1967). `value` is unit-PER-REASON — °C for a
// temperature reason, mm for a precipitation one — and for as long as that was only a
// comment, the single caller formatted every reason as an ambient temperature and 45 mm
// of rain rendered as "45°C". So the quantity is now DATA: a reason cannot exist without
// declaring what its number is, `parkedFigure` dispatches on this record rather than on
// the reason itself, and the next reason added (wind, UV, air quality) is a type error
// until it says which quantity it carries. The wrong thing is unavailable, not merely
// discouraged.
export type ParkQuantity = "temperature" | "precipitation";

export const PARK_REASON_QUANTITY: Record<ParkReason, ParkQuantity> = {
  cold: "temperature",
  hot: "temperature",
  wet: "precipitation",
};

export interface ParkedVerdict {
  activity: string;
  parked: boolean;
  reason: ParkReason | null;
  // What `value` measures, derived from `reason` through PARK_REASON_QUANTITY — carried
  // on the verdict so a consumer holding one never has to re-derive (or guess) the unit.
  // Null exactly when `reason` is.
  quantity: ParkQuantity | null;
  // The condition value that decided it (°C for cold/hot, mm for wet), or null when not
  // parked. Canonical units; the formatter converts.
  value: number | null;
  // Whether the envelope that decided this was revealed from the profile's own history.
  revealed: boolean;
}

const NOT_PARKED = (activity: string, revealed: boolean): ParkedVerdict => ({
  activity,
  parked: false,
  reason: null,
  quantity: null,
  value: null,
  revealed,
});

// A parked verdict, with the quantity resolved from the reason — the ONE place a reason
// and its unit are paired, so no branch below can hand back a value whose unit is a
// guess.
const PARKED = (
  activity: string,
  reason: ParkReason,
  value: number,
  revealed: boolean
): ParkedVerdict => ({
  activity,
  parked: true,
  reason,
  quantity: PARK_REASON_QUANTITY[reason],
  value,
  revealed,
});

// Is this outdoor activity parked in these conditions? NO WEATHER ⇒ NOT PARKED — the
// same silence-over-guessing rule as everywhere: without data the engine has no
// opinion and today's pick is unchanged. An indoor or unknown activity is never parked.
export function parkedVerdict(
  activity: string,
  day: WeatherDay | null,
  envelope: ToleranceEnvelope | null
): ParkedVerdict {
  const env = envelope ?? fallbackEnvelope(activity);
  if (!isOutdoorActivity(activity)) return NOT_PARKED(activity, env.revealed);
  if (!day) return NOT_PARKED(activity, env.revealed);

  const temp = day.tempMaxC;
  if (temp != null) {
    if (temp < env.minTempC - PARK_TEMP_MARGIN_C) {
      return PARKED(activity, "cold", temp, env.revealed);
    }
    if (temp > env.maxTempC + PARK_TEMP_MARGIN_C) {
      return PARKED(activity, "hot", temp, env.revealed);
    }
  }

  const precip = day.precipitationMm;
  if (
    precip != null &&
    precip > env.maxPrecipitationMm + PARK_PRECIP_MARGIN_MM
  ) {
    return PARKED(activity, "wet", precip, env.revealed);
  }

  return NOT_PARKED(activity, env.revealed);
}

// ---- The alternative --------------------------------------------------------------

// The indoor stand-in the engine will OFFER for a parked activity: the first mapped
// alternative the profile can actually do. "Can do" means the profile has logged it
// before or owns the equipment for it — the engine never invents a machine someone
// doesn't have. Null when none qualifies, and the caller then falls through to its
// normal next-best pick WITH THE DISCLOSURE INTACT (the #838 rule: never a silent
// disappearance).
export function pickIndoorAlternative(
  activity: string,
  canDo: (candidate: string) => boolean
): string | null {
  for (const candidate of indoorAlternatives(activity)) {
    if (canDo(candidate)) return candidate;
  }
  return null;
}

// ---- The figure a park discloses (issue #1967) ---------------------------------------
//
// One formatter, dispatching on the reason's QUANTITY rather than assuming everything is
// a temperature. The caller no longer formats anything: it hands over the canonical value
// and the login's scale, which is what makes "45 mm rendered as 45°C" unrepresentable
// rather than merely fixed.
//
// PRECIPITATION IS DESCRIBED, NOT COUNTED (the owner ruling on #1967). "45 mm" is
// accurate and useless — nobody plans a ride off millimetres. The wet figure is
// plain language ("heavy rain in the morning"): the TYPE comes from the WMO code, the
// millimetres only choose the adjective and are never printed, and the timing is said
// only when the wet hours genuinely cluster. Cold and hot keep their numbers, where the
// figure does inform.

// A precipitation intensity adjective is chosen from the day's total. The bands are wide
// on purpose: parking already implies a wet day (>13 mm under any envelope), so these
// separate "wet enough to park" from "genuinely heavy", they are not the meteorological
// light/moderate/heavy breakpoints.
export const LIGHT_PRECIP_MM = 10;
export const HEAVY_PRECIP_MM = 25;

// An hour counts as WET above this — a trace reading is not rain, and treating it as such
// would smear the timing across the whole day.
export const WET_HOUR_MM = 0.2;

// Timing needs a whole day to reason about: with hours missing, the rain could equally
// have fallen in one of them, so a cluster in what we DO have proves nothing. Below this
// many cached hours the phrase renders intensity alone.
export const MIN_TIMING_HOURS = 20;

// The weatherCodeLabel OUTPUTS that mean precipitation. Keyed on the label rather than on
// code ranges of its own, so this and the conditions stamp can never disagree about what
// counts as rain, and widening a band there reaches here for free. (weatherCodeLabel is
// declared further down with the stamps it was written for; the hoist is deliberate —
// the label belongs to that section, this is a second reader of it.)
const PRECIPITATION_LABELS = new Set([
  "drizzle",
  "rain",
  "snow",
  "showers",
  "snow showers",
  "thunderstorm",
]);

// One hour of the profile's LOCAL day, from the hourly weather cache.
export interface PrecipitationHour {
  // Hour of the local day, 0–23.
  hour: number;
  precipitationMm: number | null;
}

export type DayPart = "morning" | "afternoon" | "evening";

// The named day-parts, and the hours that belong to them. Deliberately NOT a partition of
// the 24 hours: the small hours belong to no part, so overnight rain yields no timing
// phrase rather than being rounded into "the morning".
const DAY_PARTS: readonly { part: DayPart; from: number; to: number }[] = [
  { part: "morning", from: 5, to: 11 },
  { part: "afternoon", from: 12, to: 17 },
  { part: "evening", from: 18, to: 22 },
];

export function dayPartOfHour(hour: number): DayPart | null {
  return DAY_PARTS.find((p) => hour >= p.from && hour <= p.to)?.part ?? null;
}

// When the rain falls, or null when the honest answer is "no useful pattern". SAY NOTHING
// RATHER THAN INVENT PRECISION: all-day rain, showers scattered across parts, overnight
// rain and a partially-cached day all return null and the phrase renders intensity alone.
export function precipitationTiming(
  hours: readonly PrecipitationHour[]
): DayPart | null {
  if (hours.length < MIN_TIMING_HOURS) return null;
  const wet = hours.filter(
    (h) => h.precipitationMm != null && h.precipitationMm > WET_HOUR_MM
  );
  if (wet.length === 0) return null;
  const parts = new Set<DayPart | null>(wet.map((h) => dayPartOfHour(h.hour)));
  // A wet hour outside every named part (or wet hours in more than one part) means the
  // rain does not belong to a single day-part — no timing.
  if (parts.size !== 1) return null;
  return [...parts][0];
}

// The plain-language precipitation figure — "heavy rain in the morning", "light drizzle",
// "thunderstorm". Null when the day's weather code is missing or names no precipitation
// at all: the disclosure then renders without a figure, which is the same silence-over-
// guessing rule the null value already followed. Never millimetres, never a temperature.
export function precipitationPhrase(input: {
  weatherCode: number | null;
  // The day's total, in mm. Chooses the adjective; never printed.
  precipitationMm: number | null;
  // The local day's hourly series, for the timing clause. Empty ⇒ intensity alone.
  hours?: readonly PrecipitationHour[];
}): string | null {
  const label = weatherCodeLabel(input.weatherCode);
  if (!label || !PRECIPITATION_LABELS.has(label)) return null;
  const mm = input.precipitationMm;
  // A thunderstorm carries its own intensity; "heavy thunderstorm" adds nothing.
  const modifier =
    label === "thunderstorm" || mm == null || !Number.isFinite(mm)
      ? null
      : mm < LIGHT_PRECIP_MM
        ? "light"
        : mm >= HEAVY_PRECIP_MM
          ? "heavy"
          : null;
  const kind = modifier ? `${modifier} ${label}` : label;
  const timing = precipitationTiming(input.hours ?? []);
  return timing ? `${kind} in the ${timing}` : kind;
}

export interface ParkedFigureInput {
  reason: ParkReason;
  // The condition value in CANONICAL units — °C for a temperature reason, mm for a
  // precipitation one. Null renders no figure.
  value: number | null;
  // The day's WMO weather code, for the precipitation description.
  weatherCode: number | null;
  // The local day's hourly precipitation, for its timing clause.
  hours?: readonly PrecipitationHour[];
  // The LOGIN's temperature scale. A surface with no login (a notification) passes the
  // canonical "C".
  temperatureUnit: TemperatureUnit;
}

// The figure a parked disclosure names, in the reason's OWN unit. Exhaustive over
// ParkQuantity: a new quantity fails to compile here until it says how it reads.
export function parkedFigure(input: ParkedFigureInput): string | null {
  switch (PARK_REASON_QUANTITY[input.reason]) {
    case "temperature":
      return fmtAmbientTemp(input.value, input.temperatureUnit);
    case "precipitation":
      return precipitationPhrase({
        weatherCode: input.weatherCode,
        precipitationMm: input.value,
        hours: input.hours,
      });
  }
}

// ---- Disclosure copy ---------------------------------------------------------------

export interface ParkedDisclosure {
  activity: string;
  reason: ParkReason;
  alternative: string | null;
  // The condition facts, RAW — never a pre-formatted figure (#1967). The line formats
  // them through parkedFigure, so the three surfaces cannot render the same park with
  // different units, and no caller is in a position to attach the wrong one.
  value: number | null;
  weatherCode: number | null;
  hours?: readonly PrecipitationHour[];
  temperatureUnit: TemperatureUnit;
}

// The one-line disclosure — the ONE formatter the Telegram nudge, the dashboard card
// and the Training overview all render, so the three surfaces cannot disagree about
// why the ride vanished (#221/#838). Names the alternative when there is one, and
// still explains itself when there isn't.
export function parkedDisclosureLine(d: ParkedDisclosure): string {
  const because =
    d.reason === "cold"
      ? "Too cold"
      : d.reason === "hot"
        ? "Too hot"
        : "Too wet";
  const figure = parkedFigure(d);
  const detail = figure ? ` (${figure})` : "";
  const swap = d.alternative
    ? ` — ${d.alternative} instead.`
    : " — picking something indoors instead.";
  const resumes =
    d.reason === "cold"
      ? ` Outdoor ${d.activity.toLowerCase()} resumes when it warms up.`
      : d.reason === "hot"
        ? ` Outdoor ${d.activity.toLowerCase()} resumes when it cools down.`
        : ` Outdoor ${d.activity.toLowerCase()} resumes when it dries out.`;
  return `${because} for ${d.activity.toLowerCase()}${detail}${swap}${resumes}`;
}

// ---- Forecast-ahead planning (#1724 part 5) ----------------------------------------

export interface ViableDay {
  date: string;
  viable: boolean;
  // Whether the cache actually HAD a forecast row for this day. Load-bearing, and the
  // reason this is a field rather than an inference: "no forecast" and "forecast says
  // parked" both yield viable=false and an infinite penalty, but they are opposite
  // epistemic states — one is the app having NO opinion, the other is the app having a
  // definite one. Collapsing them makes the pace composition below silently wrong.
  forecast: boolean;
  // Present for a viable day: how far inside the envelope it sits, so the scan can name
  // the BEST window rather than merely the first acceptable one. Lower is better.
  penalty: number;
}

export interface ViableDaysScan {
  days: ViableDay[];
  viableDates: string[];
  // The single best day, when one stands out. Null when none is viable, or when the
  // week is uniformly fine (nothing to plan around — see planningWorthSurfacing).
  bestDate: string | null;
  // True when the forecast reached past the reliable horizon and the scan had to
  // truncate; the copy then hedges rather than committing to a distant day.
  truncated: boolean;
  // Whether ANY scanned day had a cached forecast row. False ⇒ the app knows nothing
  // about the week and must not form an opinion about it.
  hasForecast: boolean;
}

// How far outside comfort a viable day sits — distance from the middle of the
// temperature envelope plus a precipitation term, so "best" means driest and most
// temperate, not merely "first that passes".
function dayPenalty(day: WeatherDay, env: ToleranceEnvelope): number {
  const mid = (env.minTempC + env.maxTempC) / 2;
  const tempTerm = day.tempMaxC == null ? 0 : Math.abs(day.tempMaxC - mid);
  const wetTerm = (day.precipitationMm ?? 0) * 2;
  return tempTerm + wetTerm;
}

// Scan the remaining days of the week for outdoor viability. Days beyond
// FORECAST_HORIZON_DAYS from `today` are EXCLUDED and the result is marked truncated —
// the honest-degradation rule: the app does not commit to next Wednesday's sunshine.
// A day with no cached forecast is not viable (no data ⇒ no claim), and if NO day has
// data the scan yields nothing at all rather than a confident empty answer.
export function scanViableDays(
  activity: string,
  today: string,
  candidateDates: readonly string[],
  forecast: readonly WeatherDay[],
  envelope: ToleranceEnvelope | null
): ViableDaysScan {
  const env = envelope ?? fallbackEnvelope(activity);
  const byDate = new Map(forecast.map((d) => [d.date, d]));
  const horizon = new Set<string>();
  let cursor = today;
  for (let i = 0; i <= FORECAST_HORIZON_DAYS; i++) {
    horizon.add(cursor);
    cursor = shiftDateStr(cursor, 1);
  }

  let truncated = false;
  const days: ViableDay[] = [];
  for (const date of candidateDates) {
    if (!horizon.has(date)) {
      truncated = true;
      continue;
    }
    const day = byDate.get(date);
    if (!day) {
      days.push({
        date,
        viable: false,
        forecast: false,
        penalty: Number.POSITIVE_INFINITY,
      });
      continue;
    }
    const verdict = parkedVerdict(activity, day, env);
    days.push({
      date,
      viable: !verdict.parked,
      forecast: true,
      penalty: verdict.parked ? Number.POSITIVE_INFINITY : dayPenalty(day, env),
    });
  }

  const viable = days.filter((d) => d.viable);
  const best =
    viable.length > 0
      ? [...viable].sort(
          (a, b) => a.penalty - b.penalty || a.date.localeCompare(b.date)
        )[0].date
      : null;

  return {
    days,
    viableDates: viable.map((d) => d.date),
    bestDate: best,
    truncated,
    hasForecast: days.some((d) => d.forecast),
  };
}

// Whether the plan line is worth SAYING. Viability has to be SCARCE for the line to be
// signal rather than filler: fewer viable days than the sessions still owed, or a
// single standout day among poor ones. A week where every day works needs no plan —
// the quiet-day rule.
export function planningWorthSurfacing(
  scan: ViableDaysScan,
  sessionsOwed: number
): boolean {
  if (scan.bestDate == null) return false;
  if (scan.days.length === 0) return false;
  if (scan.viableDates.length === 0) return false;
  if (scan.viableDates.length >= scan.days.length) return false;
  return scan.viableDates.length <= Math.max(1, sessionsOwed);
}

// ---- Pace composition (#1672/#1673) -------------------------------------------------

// For an OUTDOOR-scoped target, "remaining days" in the pace math becomes remaining
// VIABLE days — the composition that stops weather-awareness and pace-awareness
// contradicting each other. A ride target with three calendar days left but one dry day
// is pace-tight ON THAT DAY: the same-day deferral must not defer past it, and the
// tight-week override fires carrying the weather fact.
//
// TWO WORLDS, DELIBERATELY NOT ALIKE (the distinction `ViableDay.forecast` exists for):
//
//   • NO FORECAST AT ALL — the app knows nothing about the week. It must not form an
//     opinion, so this returns the CALENDAR count: weather must never make a target look
//     impossible merely because the forecast is missing. Silence over guessing, in the
//     direction that doesn't nag.
//   • FORECAST PRESENT, EVERY DAY PARKED — the app knows exactly one thing: there are
//     ZERO viable days. Returning the calendar count here would tell the pace math "you
//     have three days" while the weather says none, which is the precise contradiction
//     this composition exists to remove. So it returns 0.
//
// CONSUMERS MUST READ 0 AS STAND-DOWN, NOT URGENCY. Zero viable days means the outdoor
// target is not achievable this week, so the honest response is to go QUIET — never to
// escalate about something the weather has made impossible. That is the attention
// doctrine's contact-consent rule (the system may reduce contact unilaterally, never
// increase it), and it is why planningWorthSurfacing already returns false when nothing
// is viable: no viable day, no plan line.
export function remainingViableDays(
  scan: ViableDaysScan,
  calendarDaysRemaining: number
): number {
  if (scan.days.length === 0 || !scan.hasForecast) return calendarDaysRemaining;
  return scan.viableDates.length;
}

// Whether this is the LAST viable day for an outdoor target — the fact the tight-week
// override acknowledges ("last dry day this week").
export function isLastViableDay(scan: ViableDaysScan, date: string): boolean {
  return scan.viableDates.length === 1 && scan.viableDates[0] === date;
}

// The planning line — a digest This-week glance and the Upcoming planning item render
// the SAME string (#221). Null when the plan isn't worth surfacing.
export function planningLine(input: {
  activity: string;
  scan: ViableDaysScan;
  sessionsOwed: number;
  // The best day's weekday label, resolved by the caller in the profile's timezone.
  bestDayLabel: string;
  // "cycling 1/2" — the target's progress, or null.
  progressLabel: string | null;
}): string | null {
  const { activity, scan, sessionsOwed, bestDayLabel, progressLabel } = input;
  if (!planningWorthSurfacing(scan, sessionsOwed)) return null;
  const progress = progressLabel ? ` (${progressLabel})` : "";
  const hedge = scan.truncated ? " so far" : "";
  return `This week${hedge}: ${bestDayLabel} looks like the best window for your ${activity.toLowerCase()}${progress}.`;
}

// ---- Conditions stamps (#1728) ------------------------------------------------------
//
// DISPLAY ONLY. Nothing here gates, ranks, warns or sends: the point is that the data
// explains variance the user would otherwise misattribute — a slow run at 31 °C
// explains itself. Derived at read time from the same session-to-weather join the
// tolerance envelope uses (one join, two consumers), never written onto the activity
// row, so a cache gap simply renders no stamp.

// WMO weather-interpretation codes → a short human label. Grouped rather than
// enumerated: "light drizzle" vs "moderate drizzle" is more precision than a one-line
// stamp can carry, and the bands are what people actually say. An unrecognized code
// yields null and the stamp falls back to the temperature alone. Also the TYPE half of a
// wet park's description (#1967) — one vocabulary, two readers.
export function weatherCodeLabel(code: number | null): string | null {
  if (code == null || !Number.isFinite(code)) return null;
  if (code === 0) return "clear";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  if (code <= 86) return "snow showers";
  if (code <= 99) return "thunderstorm";
  return null;
}

// The compact conditions stamp for one logged OUTDOOR session — "31°C · clear". Null
// when the activity isn't outdoor (the flag decides — an indoor session gets no stamp),
// when there is no cached weather for its day, or when neither figure is known. The
// temperature is rendered in the LOGIN's scale by the caller's formatter, so this takes
// the already-formatted string.
export function conditionsStamp(input: {
  activity: string;
  tempLabel: string | null;
  weatherCode: number | null;
}): string | null {
  if (!isOutdoorActivity(input.activity)) return null;
  const label = weatherCodeLabel(input.weatherCode);
  if (input.tempLabel && label) return `${input.tempLabel} · ${label}`;
  return input.tempLabel ?? label ?? null;
}
