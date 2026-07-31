// Weather-derived situations (issue #1726) — the PURE predicates. A heatwave, a cold
// snap, a pressure swing, a high-pollen day, a poor-air-quality day are SITUATIONS in
// exactly the sense lib/situations.ts means: ephemeral, non-clinical context a
// situational intake item can key on. Joining the #1292/#1298 derived-situation family
// means three consumers arrive with no new code — situational intake gating ("the
// antihistamine when pollen is high" stops being a manual toggle), situation-impact
// correlations ("does a pressure swing explain my bad sleep"), and symptom context.
//
// POSTURE, inherited wholesale from the derived-situation family:
//
//   • DERIVED = ACTIVE, NEVER USER-MANAGED. Nothing here writes a `situations` row and
//     nothing writes a situation_events transition. The predicate IS the control: when
//     the weather stops qualifying, the situation stops — there is no toggle to forget
//     to turn off. (A user who wants a manual "Heatwave" chip can still create one; the
//     name-keyed union then simply agrees with itself.)
//   • NO DATA ⇒ NO SITUATION. A missing day, a missing variable, a profile with no home
//     location: the predicate returns off, never a guess. Silence over guessing.
//   • NO PUSHES. A weather situation activating is in-app context and a digest line.
//     The med × weather safety composition (#1727) is a separate, care-tier engine that
//     runs through the intake-safety machinery, not through situations.
//
// ANTI-JITTER (the #1490 bucketed-stability discipline). Every predicate is HYSTERETIC:
// it ENTERS at a threshold and EXITS at a strictly lower/looser one, so a borderline
// series can't flap the context on and off day after day. The exit bound is evaluated
// against the same day's data, so "still in the heatwave" is a real question about
// today rather than a memory of yesterday's answer. Duration predicates additionally
// require N CONSECUTIVE qualifying days before entering, which by construction makes a
// single freak day a non-event.
//
// This module is PURE (no DB, no clock). The DB gather is lib/queries/weather-situations
// .ts, which resolves the profile's home location + timezone, reads the cached daily
// series, and calls in here.

import { shiftDateStr } from "./date";
import type { DuringWindow } from "./protocol-compare";
import type { TemperatureUnit } from "./settings";

// ---- Identity --------------------------------------------------------------------

// The five built-in weather situations, name-keyed via sameSituation like every other
// built-in. These names are user-visible (they appear on the situations bar, in an
// item's "situational" picker, and in the impact cards), so they read as plain English.
export const BUILTIN_HEATWAVE_SITUATION = "Heatwave";
export const BUILTIN_COLD_SNAP_SITUATION = "Cold snap";
export const BUILTIN_PRESSURE_SWING_SITUATION = "Pressure swing";
export const BUILTIN_HIGH_POLLEN_SITUATION = "High pollen";
export const BUILTIN_POOR_AIR_SITUATION = "Poor air quality";

export const WEATHER_SITUATIONS = [
  BUILTIN_HEATWAVE_SITUATION,
  BUILTIN_COLD_SNAP_SITUATION,
  BUILTIN_PRESSURE_SWING_SITUATION,
  BUILTIN_HIGH_POLLEN_SITUATION,
  BUILTIN_POOR_AIR_SITUATION,
] as const;

export type WeatherSituationName = (typeof WEATHER_SITUATIONS)[number];

// ---- Named constants (adjust-in-review) -------------------------------------------
//
// Deliberately CONSERVATIVE: a situation that fires on a warm Tuesday is noise, and
// noise is what makes people stop reading. Each threshold names the meteorological
// convention it approximates; none of them is a clinical claim.

// Heatwave. Enter on daily max at/above HEATWAVE_ENTER_C for HEATWAVE_MIN_DAYS
// consecutive days (the WMO-style "several consecutive unusually hot days" shape);
// stay in while the day stays at/above the lower EXIT bound. 32 °C / 29 °C is a
// temperate-climate default; a fixed absolute threshold is the honest conservative
// choice until per-profile climate normals exist (a hot-climate profile simply sees the
// situation more often, which is true).
export const HEATWAVE_ENTER_C = 32;
export const HEATWAVE_EXIT_C = 29;
export const HEATWAVE_MIN_DAYS = 3;

// Cold snap. The mirror image: daily MAX at/below COLD_SNAP_ENTER_C (a day that never
// got above freezing) for COLD_SNAP_MIN_DAYS consecutive days, exiting above the looser
// bound. Two days rather than three: a hard freeze changes behavior faster than heat.
export const COLD_SNAP_ENTER_C = 0;
export const COLD_SNAP_EXIT_C = 3;
export const COLD_SNAP_MIN_DAYS = 2;

// Pressure swing — the migraine-relevant signal. A change of at least
// PRESSURE_SWING_ENTER_HPA in mean sea-level pressure across the trailing
// PRESSURE_SWING_WINDOW_DAYS (i.e. today vs. any of the preceding days in that window,
// so both a 24 h drop and a slower 48 h one qualify). ~8 hPa is roughly the magnitude
// the headache literature associates with weather-triggered attacks and is well above
// ordinary diurnal wobble; the exit bound keeps the context on through the tail of a
// front rather than switching off the moment the swing eases.
export const PRESSURE_SWING_ENTER_HPA = 8;
export const PRESSURE_SWING_EXIT_HPA = 5;
export const PRESSURE_SWING_WINDOW_DAYS = 2;

// High pollen, per FAMILY (grains/m³). Enter/exit pairs approximating the commonly-used
// "high" band for each family — tree and weed pollen are counted in much larger
// concentrations than grass, which is why one flat number would be wrong.
export const POLLEN_ENTER: Record<PollenFamily, number> = {
  tree: 90,
  grass: 20,
  weed: 50,
};
export const POLLEN_EXIT: Record<PollenFamily, number> = {
  tree: 50,
  grass: 10,
  weed: 25,
};

// Poor air quality. US AQI 100 is the "unhealthy for sensitive groups" breakpoint — the
// first band at which public guidance changes behavior — and 75 keeps the context on
// through the tail of an episode rather than flickering at the boundary.
export const AQI_ENTER = 100;
export const AQI_EXIT = 75;

export type PollenFamily = "tree" | "grass" | "weed";

export const POLLEN_FAMILIES: readonly PollenFamily[] = [
  "tree",
  "grass",
  "weed",
];

export const POLLEN_FAMILY_LABEL: Record<PollenFamily, string> = {
  tree: "Tree pollen",
  grass: "Grass pollen",
  weed: "Weed pollen",
};

// ---- Input shape -----------------------------------------------------------------

// One cached day, as the predicates read it. Structurally the CachedWeatherDay the
// daily cache returns, restated here so this module stays free of any DB import.
export interface WeatherDay {
  date: string;
  tempMaxC: number | null;
  tempMinC: number | null;
  pressureMslHpa: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  uvIndexMax: number | null;
  aqi: number | null;
  pollenTree: number | null;
  pollenGrass: number | null;
  pollenWeed: number | null;
}

export function pollenValue(
  day: WeatherDay,
  family: PollenFamily
): number | null {
  return family === "tree"
    ? day.pollenTree
    : family === "grass"
      ? day.pollenGrass
      : day.pollenWeed;
}

// One weather situation's state on a given date: whether it holds, and the day facts
// the state line names. `detail` values are numbers, never prose — the formatters below
// own the copy so every surface phrases it identically.
export interface WeatherSituationState {
  name: WeatherSituationName;
  on: boolean;
  // The temperature (heat/cold), pressure delta (swing), pollen concentration, or AQI
  // that made it hold. Null when off.
  value: number | null;
  // For High pollen: which family (or families) crossed. Empty otherwise.
  families: PollenFamily[];
}

// ---- The predicates ---------------------------------------------------------------
//
// All five are evaluated in ONE forward pass over the series (evaluateSeries below), a
// state machine per situation. That shape is what makes hysteresis honest: "still in
// the heatwave" is a fact about the spell so far, not a threshold re-guessed from
// scratch each day, and a GAP in the series (a day the cache is missing) resets every
// machine — no data ⇒ no claim about the days around it.
//
// A spell's first days are marked on RETROACTIVELY: a heatwave needs three consecutive
// hot days to enter, and once the third arrives all three belong to the spell. That is
// the honest span for the impact windows and the Timeline bands, and it changes nothing
// for dueness (which only ever asks about the last day of the series). The dueness
// gather deliberately passes a series ending TODAY, so a forecast hot day can never
// activate a situation ahead of time.

// Sorted ascending by date, deduped on date (last write wins).
function sortedSeries(days: readonly WeatherDay[]): WeatherDay[] {
  const byDate = new Map<string, WeatherDay>();
  for (const d of days) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The set of dates a DURATION spell covers: enter after `minDays` consecutive days
// meeting the enter bound, stay while the day meets the looser exit bound.
function spellDates(
  series: readonly WeatherDay[],
  minDays: number,
  meetsEnter: (d: WeatherDay) => boolean,
  meetsExit: (d: WeatherDay) => boolean
): Set<string> {
  const on = new Set<string>();
  let enterRun = 0;
  let inSpell = false;
  let prev: string | null = null;
  for (const d of series) {
    if (prev != null && shiftDateStr(prev, 1) !== d.date) {
      enterRun = 0;
      inSpell = false;
    }
    prev = d.date;
    if (inSpell) {
      if (meetsExit(d)) {
        on.add(d.date);
      } else {
        // The spell is over. Reset the ENTER run too: a day that failed the exit bound
        // failed the (stricter) enter bound by construction, so it contributes nothing
        // to a new run — and leaving the old count standing would let a SINGLE hot day
        // after the break re-enter the spell and backfill retroactively over the very
        // day that ended it. Re-entry must earn a fresh minDays run.
        inSpell = false;
        enterRun = 0;
      }
      continue;
    }
    if (meetsEnter(d)) {
      enterRun++;
      if (enterRun >= minDays) {
        inSpell = true;
        // Backfill the days that made up the entering run.
        let cursor = d.date;
        for (let i = 0; i < enterRun; i++) {
          on.add(cursor);
          cursor = shiftDateStr(cursor, -1);
        }
      }
    } else {
      enterRun = 0;
    }
  }
  return on;
}

// The set of dates a POINT threshold holds on, with hysteresis: enter at/above `enter`,
// stay while at/above `exit`. A missing reading (or a series gap) ends the run.
function thresholdDates(
  series: readonly WeatherDay[],
  read: (d: WeatherDay) => number | null,
  enter: number,
  exit: number
): Set<string> {
  const on = new Set<string>();
  let holding = false;
  let prev: string | null = null;
  for (const d of series) {
    if (prev != null && shiftDateStr(prev, 1) !== d.date) holding = false;
    prev = d.date;
    const v = read(d);
    if (v == null) {
      holding = false;
      continue;
    }
    if (v >= enter) holding = true;
    else if (v < exit) holding = false;
    if (holding) on.add(d.date);
  }
  return on;
}

// The largest-magnitude pressure change between `date` and any of the preceding
// `windowDays` days, or null when the window has no comparable readings. Signed:
// negative means pressure FELL into that day (the falling-barometer direction most of
// the headache literature is about), positive means it rose.
export function pressureDelta(
  days: readonly WeatherDay[],
  date: string,
  windowDays: number = PRESSURE_SWING_WINDOW_DAYS
): number | null {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = byDate.get(date)?.pressureMslHpa;
  if (today == null) return null;
  let best: number | null = null;
  for (let back = 1; back <= windowDays; back++) {
    const prior = byDate.get(shiftDateStr(date, -back))?.pressureMslHpa;
    if (prior == null) continue;
    const delta = today - prior;
    if (best == null || Math.abs(delta) > Math.abs(best)) best = delta;
  }
  return best;
}

// Per-date state for every situation, from one pass over the series. Cached per call by
// the accessors below; the DB gather calls this once and reads it many times.
export interface WeatherSituationSeries {
  // date → the states that HOLD on it (only the on ones are stored).
  byDate: Map<string, WeatherSituationState[]>;
  dates: string[];
}

export function evaluateSeries(
  days: readonly WeatherDay[]
): WeatherSituationSeries {
  const series = sortedSeries(days);
  const heat = spellDates(
    series,
    HEATWAVE_MIN_DAYS,
    (d) => d.tempMaxC != null && d.tempMaxC >= HEATWAVE_ENTER_C,
    (d) => d.tempMaxC != null && d.tempMaxC >= HEATWAVE_EXIT_C
  );
  const cold = spellDates(
    series,
    COLD_SNAP_MIN_DAYS,
    (d) => d.tempMaxC != null && d.tempMaxC <= COLD_SNAP_ENTER_C,
    (d) => d.tempMaxC != null && d.tempMaxC <= COLD_SNAP_EXIT_C
  );
  const air = thresholdDates(series, (d) => d.aqi, AQI_ENTER, AQI_EXIT);
  const pollen = new Map<PollenFamily, Set<string>>();
  for (const family of POLLEN_FAMILIES) {
    pollen.set(
      family,
      thresholdDates(
        series,
        (d) => pollenValue(d, family),
        POLLEN_ENTER[family],
        POLLEN_EXIT[family]
      )
    );
  }
  // Pressure is a delta predicate, so it is derived per day from the series rather than
  // by a running machine; hysteresis carries from the previous day's magnitude.
  const swing = new Set<string>();
  let swinging = false;
  let prev: string | null = null;
  for (const d of series) {
    if (prev != null && shiftDateStr(prev, 1) !== d.date) swinging = false;
    prev = d.date;
    const delta = pressureDelta(series, d.date);
    if (delta == null) {
      swinging = false;
      continue;
    }
    const mag = Math.abs(delta);
    if (mag >= PRESSURE_SWING_ENTER_HPA) swinging = true;
    else if (mag < PRESSURE_SWING_EXIT_HPA) swinging = false;
    if (swinging) swing.add(d.date);
  }

  const byDate = new Map<string, WeatherSituationState[]>();
  for (const d of series) {
    const states: WeatherSituationState[] = [];
    if (heat.has(d.date))
      states.push({
        name: BUILTIN_HEATWAVE_SITUATION,
        on: true,
        value: d.tempMaxC,
        families: [],
      });
    if (cold.has(d.date))
      states.push({
        name: BUILTIN_COLD_SNAP_SITUATION,
        on: true,
        value: d.tempMaxC,
        families: [],
      });
    if (swing.has(d.date))
      states.push({
        name: BUILTIN_PRESSURE_SWING_SITUATION,
        on: true,
        value: pressureDelta(series, d.date),
        families: [],
      });
    const families = POLLEN_FAMILIES.filter((f) => pollen.get(f)!.has(d.date));
    if (families.length > 0)
      states.push({
        name: BUILTIN_HIGH_POLLEN_SITUATION,
        on: true,
        value: pollenValue(d, families[0]),
        families: [...families],
      });
    if (air.has(d.date))
      states.push({
        name: BUILTIN_POOR_AIR_SITUATION,
        on: true,
        value: d.aqi,
        families: [],
      });
    if (states.length > 0) byDate.set(d.date, states);
  }
  return { byDate, dates: series.map((d) => d.date) };
}

// Every weather situation that HOLDS on `date`, in the stable predicate order. The ONE
// entry point — the dueness widening, the state lines, the Timeline notable-day test,
// and the impact windows all read THIS, so they can never disagree about what a
// heatwave is.
export function evaluateWeatherSituations(
  days: readonly WeatherDay[],
  date: string
): WeatherSituationState[] {
  return evaluateSeries(days).byDate.get(date) ?? [];
}

// The names that hold on `date` — what the effective-active-situation set unions in.
export function activeWeatherSituations(
  days: readonly WeatherDay[],
  date: string
): WeatherSituationName[] {
  return evaluateWeatherSituations(days, date).map((s) => s.name);
}

// ---- Notable days + impact windows -------------------------------------------------

// Whether a date is "notable" for display purposes (#1728's Timeline day context and
// chart bands): any weather situation holds. Deliberately the SAME predicate set the
// dueness widening uses — one predicate set, several display consumers, so a day the
// Timeline calls notable is exactly a day a situational item would have gone due.
export function isNotableWeatherDay(
  days: readonly WeatherDay[],
  date: string
): boolean {
  return activeWeatherSituations(days, date).length > 0;
}

// A weather situation's dated DURING-WINDOWS over a cached series — the input the
// pooled situation-impact engine (lib/situation-impact) needs to answer "how does a
// heatwave affect my sleep/HRV/mood".
//
// The #1360 window-source rule says situation_events is DECLARED-only and a derived
// situation contributes no windows, because a derived situation (poor sleep, period)
// has no dated span the app can reconstruct — only a per-day verdict. Weather is the
// case that rule was not written for: the spell is a FACT in a cached series, fully
// reconstructable and identical every time it is computed. So the windows come from the
// predicate over the cache, not from a transition log, and still nothing is written.
//
// Contiguous qualifying dates collapse into one window. Days absent from the series
// break a window (no data ⇒ no claim about that day).
export function weatherSituationWindows(
  days: readonly WeatherDay[],
  situation: WeatherSituationName
): DuringWindow[] {
  const evaluated = evaluateSeries(days);
  const windows: DuringWindow[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const date of evaluated.dates) {
    const on = (evaluated.byDate.get(date) ?? []).some(
      (s) => s.name === situation
    );
    if (on) {
      // A gap in the cached series breaks the window: the app has no reading for the
      // missing day, so it must not claim the spell ran through it.
      if (start != null && prev != null && shiftDateStr(prev, 1) !== date) {
        windows.push({ start, end: prev });
        start = date;
      } else if (start == null) {
        start = date;
      }
      prev = date;
    } else if (start != null && prev != null) {
      windows.push({ start, end: prev });
      start = null;
      prev = null;
    }
  }
  if (start != null && prev != null) windows.push({ start, end: prev });
  return windows;
}

// ---- Figure formatters ---------------------------------------------------------
//
// AMBIENT temperature (canonical °C, like activities.avg_temp_c) is a different
// quantity from BODY temperature (canonical °F, the fever pref) — but it is still shown
// to a person who has told us which scale they read in, so it routes through the
// login's TemperatureUnit rather than always printing °C.

const DEGREE_C = "°C";
const DEGREE_F = "°F";

// An ambient °C reading in the login's preferred scale, rounded to the whole degree
// (weather is not read to a tenth): "32°C" / "90°F".
export function fmtAmbientTemp(
  celsius: number | null | undefined,
  unit: TemperatureUnit
): string | null {
  if (celsius == null || !Number.isFinite(celsius)) return null;
  const value =
    unit === "C" ? Math.round(celsius) : Math.round(celsius * (9 / 5) + 32);
  return `${value}${unit === "C" ? DEGREE_C : DEGREE_F}`;
}

// The figure a weather situation's state line names, in the login's units. Null when
// the driving value is missing — the line then renders without a figure rather than
// with a wrong one.
export function weatherSituationFigure(
  state: WeatherSituationState,
  unit: TemperatureUnit
): string | null {
  if (state.value == null) return null;
  switch (state.name) {
    case BUILTIN_HEATWAVE_SITUATION:
    case BUILTIN_COLD_SNAP_SITUATION:
      return fmtAmbientTemp(state.value, unit);
    case BUILTIN_PRESSURE_SWING_SITUATION: {
      // A real minus glyph, and the sign is the point: a FALL is the direction most of
      // the headache association is about.
      const rounded = Math.round(state.value);
      const sign = rounded < 0 ? "−" : "+";
      return `${sign}${Math.abs(rounded)} hPa`;
    }
    case BUILTIN_HIGH_POLLEN_SITUATION: {
      const family = state.families[0];
      return family ? POLLEN_FAMILY_LABEL[family].toLowerCase() : null;
    }
    case BUILTIN_POOR_AIR_SITUATION:
      return `AQI ${Math.round(state.value)}`;
  }
}

// ---- State-line formatters ---------------------------------------------------------

// A temperature rendered for the state line. Canonical storage is °C; the display layer
// converts when the login prefers Fahrenheit (formatTemperature), so this formatter
// takes the ALREADY-FORMATTED string to stay unit-agnostic and pure.
export interface WeatherSituationLineInput {
  state: WeatherSituationState;
  // The number the line names, already unit-formatted by the caller ("34°C", "91°F",
  // "AQI 118", "−11 hPa"). Null renders a line with no figure rather than a wrong one.
  figure: string | null;
  // How many situational intake items keyed to this situation are now due. 0 renders
  // no line: with nothing keyed, the context has nothing to acknowledge (the same rule
  // poorSleepStateLine follows).
  itemCount: number;
}

// The one-line acknowledgment for an active weather situation — the ONE formatter the
// situations bar, the check-in Context disclosure, and the digest all render, so a
// Telegram-first user reads exactly what the page says (#662/#221). Null when the
// situation is off or nothing is keyed to it.
export function weatherSituationStateLine(
  input: WeatherSituationLineInput
): string | null {
  const { state, figure, itemCount } = input;
  if (!state.on || itemCount <= 0) return null;
  const items = `${itemCount} ${itemCount === 1 ? "item" : "items"} active`;
  const detail = figure ? ` (${figure})` : "";
  return `${state.name}${detail} — ${items} (auto)`;
}

// The compact conditions summary for a notable day (#1728's Timeline day header): the
// active situation names, in the stable predicate order. Null on a quiet day — notable
// by exception, silent by default.
export function notableDaySummary(
  days: readonly WeatherDay[],
  date: string
): string | null {
  const active = activeWeatherSituations(days, date);
  return active.length > 0 ? active.join(" · ") : null;
}
