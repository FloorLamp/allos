// The DB gather half of the weather-derived situations (issue #1726). The pure
// predicates + formatters live in lib/weather-situations.ts; this module reads the
// profile-scoped inputs they need:
//
//   • the cached DAILY series for the profile's coarse home location, over a lookback
//     window ending on the given LOCAL date, and
//   • the relevance gate that decides whether this profile should see weather
//     situations at all.
//
// The series is always read in the profile's own timezone-resolved calendar day (the
// caller passes `date` = today in the profile's timezone), because a "heatwave day" is
// a local-calendar fact — the per-profile-context trap the derived-situation family
// documents.
//
// FORECAST DAYS ARE EXCLUDED from the dueness/state series. The cache reaches a week
// ahead (the planning surfaces need it), but a situation must never activate on
// weather that hasn't happened: the series handed to the predicates ends at `date`.

import { db } from "../db";
import { getHomeLocation } from "../settings";
import { getWeatherDays } from "../integrations/weather-cache";
import { getIntakeItems } from "./intake/schedule";
import { shiftDateStr } from "../date";
import { sameSituation } from "../situations";
import {
  activeWeatherSituations,
  evaluateWeatherSituations,
  weatherSituationWindows,
  WEATHER_SITUATIONS,
  type WeatherDay,
  type WeatherSituationName,
  type WeatherSituationState,
} from "../weather-situations";

// How much trailing series the predicates need. The longest predicate is the heatwave's
// consecutive-day run plus its hysteresis tail; 45 days is comfortably beyond any spell
// the app claims to see and keeps the read a small indexed range scan.
export const WEATHER_SERIES_LOOKBACK_DAYS = 45;

// How much series the IMPACT windows read. Longer, because the pooled comparison is
// answering "across the seasons I have data for" — bounded by the sync's own retention
// (the cache only holds what has been fetched), so this is a ceiling, not a promise.
export const WEATHER_IMPACT_LOOKBACK_DAYS = 400;

// The cached daily series for a profile's home location ending on `date` (inclusive).
// Empty when the profile has no home location — the weather features are then quietly
// absent, the #570 degrade-gracefully pattern the whole sun/weather family follows.
export function getWeatherSeries(
  profileId: number,
  date: string,
  lookbackDays: number = WEATHER_SERIES_LOOKBACK_DAYS
): WeatherDay[] {
  const home = getHomeLocation(profileId);
  if (!home) return [];
  return getWeatherDays(
    home.lat,
    home.lng,
    shiftDateStr(date, -lookbackDays),
    date
  );
}

// The cached series INCLUDING the forecast tail, for the planning/display consumers
// that legitimately look ahead. Never used for situation activation.
export function getWeatherSeriesThrough(
  profileId: number,
  startDate: string,
  endDate: string
): WeatherDay[] {
  const home = getHomeLocation(profileId);
  if (!home) return [];
  return getWeatherDays(home.lat, home.lng, startDate, endDate);
}

// ---- Relevance gating -------------------------------------------------------------
//
// The #1298 cycle-relevance pattern: a profile that has never linked anything to a
// weather situation and logs none of the symptoms these situations explain does not
// need five new context rows appearing in its life. Relevance is DATA-DRIVEN and
// re-evaluated every time — it turns itself on the moment the user keys an item to
// "High pollen", and it never needs a setting.
//
// The symptom half is the discovery path: someone logging headaches through a
// front-passage week should be offered the pressure-swing context without having had to
// think of it first. Kept to the symptoms these five situations actually explain — this
// is not an excuse to surface weather context to everyone who ever felt unwell.

// Symptom names (matched case-insensitively as substrings, the same loose vocabulary
// match the condition→situation bridge uses) that a weather situation could plausibly
// contextualize.
const WEATHER_RELEVANT_SYMPTOMS = [
  "headache",
  "migraine",
  "sinus",
  "congestion",
  "runny nose",
  "sneez",
  "itchy eyes",
  "allerg",
  "hay fever",
  "asthma",
  "wheez",
  "short of breath",
  "breathless",
  "cough",
  "joint pain",
];

// How far back the symptom half of the relevance gate looks. A season: long enough that
// a spring allergy sufferer stays relevant through a quiet autumn month, short enough
// that a one-off headache two years ago doesn't pin the context on forever.
export const WEATHER_RELEVANCE_SYMPTOM_DAYS = 180;

// Whether ANY active situational intake item is keyed to a weather situation. The
// primary relevance signal — the user has already said these matter.
function hasWeatherKeyedItem(profileId: number): boolean {
  return getIntakeItems(profileId).some(
    (s: {
      active?: number | boolean;
      condition?: string;
      situation?: string | null;
    }) =>
      (s.active ?? true) &&
      s.condition === "situational" &&
      s.situation != null &&
      WEATHER_SITUATIONS.some((w) => sameSituation(s.situation!, w))
  );
}

// The DATES on which the profile logged a weather-explainable symptom, over an
// inclusive range. One ranged read whatever the range's width, so the relevance gate
// costs the same for one day as for a window of them — the per-day answer is a scan of
// what came back, not a second query.
function weatherRelevantSymptomDates(
  profileId: number,
  from: string,
  to: string
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT date, symptom FROM symptom_logs
        WHERE profile_id = ? AND date >= ? AND date <= ?`
    )
    .all(profileId, from, to) as { date: string; symptom: string }[];
  return rows
    .filter((r) => {
      const s = r.symptom.toLowerCase();
      return WEATHER_RELEVANT_SYMPTOMS.some((k) => s.includes(k));
    })
    .map((r) => r.date);
}

// Whether weather situations are relevant for this profile: weather data must exist
// (a home location, hence a sync) AND the profile must have either keyed something to a
// weather situation or logged a symptom these situations explain. Missing either half
// ⇒ no weather situations anywhere, which is the silent default.
export function weatherSituationsRelevant(
  profileId: number,
  date: string
): boolean {
  return weatherSituationsResolver(profileId, date, date)(date).relevant;
}

// ---- Resolution -------------------------------------------------------------------

export interface ResolvedWeatherSituations {
  // The states that HOLD on `date`, in the stable predicate order. Empty when the
  // profile isn't relevant, has no home location, or the cache has no qualifying data.
  active: WeatherSituationState[];
  // The names to union into the effective active-situation set.
  names: Set<string>;
  // Whether weather situations are relevant for this profile ON `date` — the gate,
  // surfaced so a caller that only wants the gate doesn't re-ask for it.
  relevant: boolean;
}

const NO_WEATHER_SITUATIONS: ResolvedWeatherSituations = {
  active: [],
  names: new Set(),
  relevant: false,
};

// Per-day weather-situation resolution over a WINDOW of days, off ONE read of each
// input: the home location, the keyed-item gate, the symptom dates, and the cached
// series. Asking day by day re-read all four once per day, which is the cost that made
// a dated answer look too expensive for the summary surfaces (#3993). It isn't: the
// query count is the same for one day as for fifty-six, and only the in-memory
// evaluation repeats.
//
// EACH DAY IS STILL ANSWERED AS-OF ITSELF, which is the part that must not be traded
// for the saving. `evaluateSeries` backfills a spell's entering run RETROACTIVELY, so
// handing it a series that runs past `date` can turn a day on that the app could not
// have known about on the day. Every day here is therefore evaluated over exactly the
// slice `getWeatherSeries(profileId, date)` would have read — the lookback ending on
// that day — so a windowed answer and a single-day answer are the same answer.
//
// The window is a COST HINT, not a contract: a date outside [from, to] is answered by
// reading its own slice, so a caller cannot get a wrong answer by mis-declaring it.
export function weatherSituationsResolver(
  profileId: number,
  from: string,
  to: string
): (date: string) => ResolvedWeatherSituations {
  const home = getHomeLocation(profileId);
  if (!home) return () => NO_WEATHER_SITUATIONS;
  // The primary gate; when it holds, the symptom half is never consulted and never read.
  const keyed = hasWeatherKeyedItem(profileId);
  const symptomFrom = shiftDateStr(from, -WEATHER_RELEVANCE_SYMPTOM_DAYS);
  const symptomDates = keyed
    ? []
    : weatherRelevantSymptomDates(profileId, symptomFrom, to);
  const seriesFrom = shiftDateStr(from, -WEATHER_SERIES_LOOKBACK_DAYS);
  const series = getWeatherDays(home.lat, home.lng, seriesFrom, to);
  return (date) => {
    const covered = date >= from && date <= to;
    const relevant =
      keyed ||
      (covered
        ? symptomDates.some(
            (d) => d >= shiftDateStr(date, -WEATHER_RELEVANCE_SYMPTOM_DAYS)
          )
        : weatherRelevantSymptomDates(
            profileId,
            shiftDateStr(date, -WEATHER_RELEVANCE_SYMPTOM_DAYS),
            date
          ).length > 0);
    if (!relevant) return NO_WEATHER_SITUATIONS;
    const since = shiftDateStr(date, -WEATHER_SERIES_LOOKBACK_DAYS);
    const slice = covered
      ? series.filter((d) => d.date >= since && d.date <= date)
      : getWeatherSeries(profileId, date);
    const active = evaluateWeatherSituations(slice, date);
    return {
      active,
      names: new Set(active.map((s) => s.name)),
      relevant: true,
    };
  };
}

export function resolveWeatherSituations(
  profileId: number,
  date: string
): ResolvedWeatherSituations {
  return weatherSituationsResolver(profileId, date, date)(date);
}

// The active weather-situation NAMES only — the cheap path for the dueness widening,
// which needs the set and none of the figures.
export function activeWeatherSituationNames(
  profileId: number,
  date: string
): string[] {
  return [...resolveWeatherSituations(profileId, date).names];
}

// The dated during-windows for one weather situation over the profile's cached history
// — the input the pooled situation-impact engine consumes (#1297). Reconstructed from
// the predicate over the cache rather than from a transition log, which is why a derived
// WEATHER situation carries an impact card where derived poor-sleep does not: the spell
// is a run of days anyone can recompute, while a rough night is dated (#3993) but never
// collected into a span (the #1360 window-source rule, and weather's exception to it).
export function getWeatherSituationWindows(
  profileId: number,
  situation: WeatherSituationName,
  today: string
) {
  const series = getWeatherSeries(
    profileId,
    today,
    WEATHER_IMPACT_LOOKBACK_DAYS
  );
  return weatherSituationWindows(series, situation);
}

// ---- Ungated reads for the SAFETY composition (#1727) ------------------------------
//
// The relevance gate above exists so five context rows don't appear in the life of
// someone with no reason to care — a CALM-surface concern. A care-tier safety note has
// its own, stricter gate: you are taking a medication the conditions interact with. So
// the med × weather composition asks the predicates DIRECTLY, without the relevance
// gate, and would otherwise be silenced by an unrelated fact (that the user hasn't
// keyed a supplement to pollen). The home-location gate still applies — no weather
// data, no claim.

// Whether a named weather situation holds on `date`, ungated by relevance.
export function weatherSituationHolds(
  profileId: number,
  situation: WeatherSituationName,
  date: string
): boolean {
  return activeWeatherSituations(
    getWeatherSeries(profileId, date),
    date
  ).includes(situation);
}

// The single cached day for a profile's home location, or null when there is no home
// location or no cached row. The day-level figures (peak UV, max temperature) the
// safety composition and the display stamps read.
export function getWeatherDay(
  profileId: number,
  date: string
): WeatherDay | null {
  const home = getHomeLocation(profileId);
  if (!home) return null;
  const [row] = getWeatherDays(home.lat, home.lng, date, date);
  return row ?? null;
}

// The cached daily series for a profile's home location over an inclusive date range —
// the #1728 display read (training log stamps, Timeline day context). Empty without a home
// location, so those surfaces quietly render nothing.
export function getWeatherDaysForProfile(
  profileId: number,
  startDate: string,
  endDate: string
): WeatherDay[] {
  const home = getHomeLocation(profileId);
  if (!home) return [];
  return getWeatherDays(home.lat, home.lng, startDate, endDate);
}
