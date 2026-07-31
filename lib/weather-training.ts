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
import type { WeatherDay } from "./weather-situations";

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

export interface ParkedVerdict {
  activity: string;
  parked: boolean;
  reason: ParkReason | null;
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
  value: null,
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
      return {
        activity,
        parked: true,
        reason: "cold",
        value: temp,
        revealed: env.revealed,
      };
    }
    if (temp > env.maxTempC + PARK_TEMP_MARGIN_C) {
      return {
        activity,
        parked: true,
        reason: "hot",
        value: temp,
        revealed: env.revealed,
      };
    }
  }

  const precip = day.precipitationMm;
  if (
    precip != null &&
    precip > env.maxPrecipitationMm + PARK_PRECIP_MARGIN_MM
  ) {
    return {
      activity,
      parked: true,
      reason: "wet",
      value: precip,
      revealed: env.revealed,
    };
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

// ---- Disclosure copy ---------------------------------------------------------------

export interface ParkedDisclosure {
  activity: string;
  reason: ParkReason;
  alternative: string | null;
  // The already-unit-formatted condition figure ("−2°C", "12 mm"), or null.
  figure: string | null;
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
  const figure = d.figure ? ` (${d.figure})` : "";
  const swap = d.alternative
    ? ` — ${d.alternative} instead.`
    : " — picking something indoors instead.";
  const resumes =
    d.reason === "cold"
      ? ` Outdoor ${d.activity.toLowerCase()} resumes when it warms up.`
      : d.reason === "hot"
        ? ` Outdoor ${d.activity.toLowerCase()} resumes when it cools down.`
        : ` Outdoor ${d.activity.toLowerCase()} resumes when it dries out.`;
  return `${because} for ${d.activity.toLowerCase()}${figure}${swap}${resumes}`;
}

// ---- Forecast-ahead planning (#1724 part 5) ----------------------------------------

export interface ViableDay {
  date: string;
  viable: boolean;
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
      days.push({ date, viable: false, penalty: Number.POSITIVE_INFINITY });
      continue;
    }
    const verdict = parkedVerdict(activity, day, env);
    days.push({
      date,
      viable: !verdict.parked,
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
// Returns the count the pace math should use. A scan with NO weather data at all falls
// back to the calendar count (silence over guessing — weather must not make a target
// look impossible just because the forecast is missing).
export function remainingViableDays(
  scan: ViableDaysScan,
  calendarDaysRemaining: number
): number {
  const hasAnyData = scan.days.some(
    (d) => Number.isFinite(d.penalty) || d.viable
  );
  if (scan.days.length === 0 || !hasAnyData) return calendarDaysRemaining;
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
