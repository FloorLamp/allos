import { describe, expect, it } from "vitest";
import {
  AQI_ENTER,
  AQI_EXIT,
  BUILTIN_COLD_SNAP_SITUATION,
  BUILTIN_HEATWAVE_SITUATION,
  BUILTIN_HIGH_POLLEN_SITUATION,
  BUILTIN_POOR_AIR_SITUATION,
  BUILTIN_PRESSURE_SWING_SITUATION,
  COLD_SNAP_ENTER_C,
  COLD_SNAP_MIN_DAYS,
  HEATWAVE_ENTER_C,
  HEATWAVE_EXIT_C,
  HEATWAVE_MIN_DAYS,
  POLLEN_ENTER,
  POLLEN_EXIT,
  PRESSURE_SWING_ENTER_HPA,
  activeWeatherSituations,
  evaluateSeries,
  evaluateWeatherSituations,
  fmtAmbientTemp,
  isNotableWeatherDay,
  notableDaySummary,
  notableStatesSummary,
  pressureDelta,
  weatherSituationFigure,
  weatherSituationStateLine,
  weatherSituationWindows,
  type WeatherDay,
} from "@/lib/weather-situations";
import { shiftDateStr } from "@/lib/date";

// Pure predicate tests for the weather-derived situations (#1726). No DB, no clock: a
// synthetic daily series in, an active-situation set out. The load-bearing properties
// are (a) hysteresis — a borderline series must not flap, (b) consecutive-day runs that
// survive a month boundary, and (c) missing data producing SILENCE rather than a guess.

// A day with everything absent; each fixture overrides only what it is about, which is
// also the honest shape of a partial provider response.
function day(date: string, over: Partial<WeatherDay> = {}): WeatherDay {
  return {
    date,
    tempMaxC: null,
    tempMinC: null,
    pressureMslHpa: null,
    precipitationMm: null,
    weatherCode: null,
    uvIndexMax: null,
    aqi: null,
    pollenTree: null,
    pollenGrass: null,
    pollenWeed: null,
    ...over,
  };
}

// A contiguous series starting at `start`, one day per value.
function series(
  start: string,
  values: readonly Partial<WeatherDay>[]
): WeatherDay[] {
  return values.map((v, i) => day(shiftDateStr(start, i), v));
}

function tempSeries(start: string, temps: readonly number[]): WeatherDay[] {
  return series(
    start,
    temps.map((t) => ({ tempMaxC: t }))
  );
}

function on(days: WeatherDay[], date: string): string[] {
  return activeWeatherSituations(days, date);
}

describe("heatwave predicate (#1726)", () => {
  it("needs the full consecutive run before it enters", () => {
    const days = tempSeries("2026-07-01", [34, 34, 34]);
    // Days 1 and 2 alone are not yet a heatwave — but once the third arrives the spell
    // covers all three (the honest span for windows and bands).
    expect(on(tempSeries("2026-07-01", [34]), "2026-07-01")).toEqual([]);
    expect(on(tempSeries("2026-07-01", [34, 34]), "2026-07-02")).toEqual([]);
    expect(on(days, "2026-07-03")).toContain(BUILTIN_HEATWAVE_SITUATION);
    expect(on(days, "2026-07-01")).toContain(BUILTIN_HEATWAVE_SITUATION);
  });

  it("stays on through the hysteresis band and exits below it", () => {
    // Three hot days enter; a day between EXIT and ENTER keeps it on; a cooler day ends
    // it. Without hysteresis the 30 °C day would have flipped it off and the 33 °C day
    // back on — the exact flapping the band exists to prevent.
    const days = tempSeries("2026-07-01", [33, 33, 33, 30, 33, 25]);
    expect(on(days, "2026-07-04")).toContain(BUILTIN_HEATWAVE_SITUATION);
    expect(on(days, "2026-07-05")).toContain(BUILTIN_HEATWAVE_SITUATION);
    expect(on(days, "2026-07-06")).not.toContain(BUILTIN_HEATWAVE_SITUATION);
  });

  it("does not flap on a borderline series that never enters", () => {
    // Every day sits in the band [EXIT, ENTER) — warm, never hot enough to enter. The
    // situation must never turn on, on any day.
    const borderline = HEATWAVE_EXIT_C + 1;
    expect(borderline).toBeLessThan(HEATWAVE_ENTER_C);
    const days = tempSeries("2026-07-01", Array(10).fill(borderline));
    for (const d of days) {
      expect(on(days, d.date)).not.toContain(BUILTIN_HEATWAVE_SITUATION);
    }
  });

  it("re-entry after a spell ends needs a FRESH consecutive run", () => {
    // The regression this pins: on exiting a spell the ENTER run must reset. When it
    // didn't, a single hot day after the break re-entered the spell AND the backfill
    // retroactively stamped the exit day itself as in-spell — a 25 °C day reported as
    // an active Heatwave, leaking into dueness, notable days, impact windows and the
    // care-tier heat-risk note.
    const days = tempSeries("2026-07-01", [35, 35, 35, 25, 33, 20]);
    // The spell covers its three qualifying days.
    expect(on(days, "2026-07-03")).toContain(BUILTIN_HEATWAVE_SITUATION);
    // The exit day is OFF — it is the day that ended the spell.
    expect(on(days, "2026-07-04")).not.toContain(BUILTIN_HEATWAVE_SITUATION);
    // And one hot day afterwards does NOT re-enter: re-entry earns its own run.
    expect(on(days, "2026-07-05")).not.toContain(BUILTIN_HEATWAVE_SITUATION);
    // No window ever claimed the exit day.
    expect(weatherSituationWindows(days, BUILTIN_HEATWAVE_SITUATION)).toEqual([
      { start: "2026-07-01", end: "2026-07-03" },
    ]);
  });

  it("re-enters once a fresh full run arrives", () => {
    const days = tempSeries("2026-07-01", [35, 35, 35, 20, 34, 34, 34]);
    expect(on(days, "2026-07-07")).toContain(BUILTIN_HEATWAVE_SITUATION);
    expect(weatherSituationWindows(days, BUILTIN_HEATWAVE_SITUATION)).toEqual([
      { start: "2026-07-01", end: "2026-07-03" },
      { start: "2026-07-05", end: "2026-07-07" },
    ]);
  });

  it("counts consecutive days across a month boundary", () => {
    const days = tempSeries("2026-07-30", [35, 35, 35]);
    expect(days.map((d) => d.date)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
    ]);
    expect(on(days, "2026-08-01")).toContain(BUILTIN_HEATWAVE_SITUATION);
  });

  it("counts consecutive days across a leap-year February boundary", () => {
    const days = tempSeries("2028-02-28", [33, 33, 33, 33]);
    expect(days.map((d) => d.date)).toContain("2028-02-29");
    expect(on(days, "2028-03-01")).toContain(BUILTIN_HEATWAVE_SITUATION);
  });

  it("breaks the run on a GAP in the cached series (no data ⇒ no claim)", () => {
    // Two hot days, a missing day, another hot day: that is not a three-day run,
    // because the app has no reading for the day in between.
    const days = [
      day("2026-07-01", { tempMaxC: 35 }),
      day("2026-07-02", { tempMaxC: 35 }),
      day("2026-07-04", { tempMaxC: 35 }),
    ];
    expect(on(days, "2026-07-04")).not.toContain(BUILTIN_HEATWAVE_SITUATION);
  });

  it("stays silent when temperature is missing entirely", () => {
    const days = series("2026-07-01", [{}, {}, {}, {}]);
    expect(on(days, "2026-07-04")).toEqual([]);
  });

  it("ignores a single freak hot day", () => {
    const days = tempSeries("2026-07-01", [18, 19, 36, 19, 18]);
    expect(on(days, "2026-07-03")).not.toContain(BUILTIN_HEATWAVE_SITUATION);
  });
});

describe("cold-snap predicate (#1726)", () => {
  it("enters after its own (shorter) consecutive run", () => {
    const days = tempSeries("2026-01-10", Array(COLD_SNAP_MIN_DAYS).fill(-4));
    const last = days[days.length - 1].date;
    expect(on(days, last)).toContain(BUILTIN_COLD_SNAP_SITUATION);
  });

  it("does not fire on one freezing day", () => {
    const days = tempSeries("2026-01-10", [6, COLD_SNAP_ENTER_C - 1, 6]);
    expect(on(days, "2026-01-11")).not.toContain(BUILTIN_COLD_SNAP_SITUATION);
  });

  it("stays on through a thaw inside the band and exits above it", () => {
    const days = tempSeries("2026-01-10", [-3, -3, 2, -3, 8]);
    expect(on(days, "2026-01-12")).toContain(BUILTIN_COLD_SNAP_SITUATION);
    expect(on(days, "2026-01-14")).not.toContain(BUILTIN_COLD_SNAP_SITUATION);
  });

  it("also needs a fresh run to re-enter after a thaw ends the snap", () => {
    // The same exit-path reset, on the other spellDates caller.
    const days = tempSeries("2026-01-10", [-3, -3, 8, -3, 6]);
    expect(on(days, "2026-01-11")).toContain(BUILTIN_COLD_SNAP_SITUATION);
    expect(on(days, "2026-01-12")).not.toContain(BUILTIN_COLD_SNAP_SITUATION);
    expect(on(days, "2026-01-13")).not.toContain(BUILTIN_COLD_SNAP_SITUATION);
  });

  it("never holds at the same time as a heatwave", () => {
    const days = tempSeries("2026-07-01", [34, 34, 34, 34]);
    const active = on(days, "2026-07-04");
    expect(active).toContain(BUILTIN_HEATWAVE_SITUATION);
    expect(active).not.toContain(BUILTIN_COLD_SNAP_SITUATION);
  });
});

describe("pressure-swing predicate (#1726)", () => {
  it("reports the signed delta over the trailing window", () => {
    const days = series("2026-03-01", [
      { pressureMslHpa: 1020 },
      { pressureMslHpa: 1018 },
      { pressureMslHpa: 1004 },
    ]);
    // The largest-magnitude comparison in the window is 1004 − 1020 = −16.
    expect(pressureDelta(days, "2026-03-03")).toBe(-16);
  });

  it("fires on a fall of at least the threshold and not on a smaller one", () => {
    const drop = series("2026-03-01", [
      { pressureMslHpa: 1015 },
      { pressureMslHpa: 1015 - PRESSURE_SWING_ENTER_HPA },
    ]);
    expect(on(drop, "2026-03-02")).toContain(BUILTIN_PRESSURE_SWING_SITUATION);

    const wobble = series("2026-03-01", [
      { pressureMslHpa: 1015 },
      { pressureMslHpa: 1013 },
      { pressureMslHpa: 1014 },
    ]);
    for (const d of wobble) {
      expect(on(wobble, d.date)).not.toContain(
        BUILTIN_PRESSURE_SWING_SITUATION
      );
    }
  });

  it("fires on a RISE too — the signal is the change, not the direction", () => {
    const days = series("2026-03-01", [
      { pressureMslHpa: 1000 },
      { pressureMslHpa: 1000 + PRESSURE_SWING_ENTER_HPA + 2 },
    ]);
    expect(on(days, "2026-03-02")).toContain(BUILTIN_PRESSURE_SWING_SITUATION);
  });

  it("stays silent with only one day of pressure (nothing to compare)", () => {
    const days = series("2026-03-01", [{ pressureMslHpa: 1000 }]);
    expect(pressureDelta(days, "2026-03-01")).toBeNull();
    expect(on(days, "2026-03-01")).toEqual([]);
  });

  it("breaks the hysteresis carry on a GAP in the cached series", () => {
    // The swing machine carries "still swinging" across a day whose own delta sits in
    // the band [EXIT, ENTER) — but only over CONTIGUOUS days. A missing day means the
    // app cannot claim the swing ran through it, so the carry resets and the band day
    // is no longer enough on its own.
    const contiguous = series("2026-03-01", [
      { pressureMslHpa: 1015 },
      { pressureMslHpa: 1007 }, // −8 → enters
      { pressureMslHpa: 1012 }, // +5 → in the band, carries
      { pressureMslHpa: 1013 }, // +6 vs 03-02 → in the band, carries
    ]);
    expect(on(contiguous, "2026-03-02")).toContain(
      BUILTIN_PRESSURE_SWING_SITUATION
    );
    expect(on(contiguous, "2026-03-04")).toContain(
      BUILTIN_PRESSURE_SWING_SITUATION
    );

    const gapped = [
      day("2026-03-01", { pressureMslHpa: 1015 }),
      day("2026-03-02", { pressureMslHpa: 1007 }),
      // 2026-03-03 missing.
      day("2026-03-04", { pressureMslHpa: 1013 }),
    ];
    expect(on(gapped, "2026-03-02")).toContain(
      BUILTIN_PRESSURE_SWING_SITUATION
    );
    // Its own delta (+6 against 03-02) is still inside the band, so ONLY the gap reset
    // can turn this day off.
    expect(pressureDelta(gapped, "2026-03-04")).toBe(6);
    expect(on(gapped, "2026-03-04")).not.toContain(
      BUILTIN_PRESSURE_SWING_SITUATION
    );
  });
});

describe("pollen + air-quality predicates (#1726)", () => {
  it("fires per family and names which one", () => {
    const days = series("2026-05-01", [
      { pollenGrass: POLLEN_ENTER.grass + 5 },
    ]);
    const states = evaluateWeatherSituations(days, "2026-05-01");
    const pollen = states.find(
      (s) => s.name === BUILTIN_HIGH_POLLEN_SITUATION
    )!;
    expect(pollen.families).toEqual(["grass"]);
  });

  it("names EVERY family that crossed on the same day, in the stable order", () => {
    // Two families high at once is ONE High-pollen state carrying both names, never two
    // duplicate states — and the figure names the first family in the canonical order.
    const days = series("2026-05-01", [
      {
        pollenGrass: POLLEN_ENTER.grass + 5,
        pollenWeed: POLLEN_ENTER.weed + 5,
      },
    ]);
    const states = evaluateWeatherSituations(days, "2026-05-01");
    const pollenStates = states.filter(
      (s) => s.name === BUILTIN_HIGH_POLLEN_SITUATION
    );
    expect(pollenStates).toHaveLength(1);
    expect(pollenStates[0].families).toEqual(["grass", "weed"]);
    expect(pollenStates[0].value).toBe(POLLEN_ENTER.grass + 5);
    expect(weatherSituationFigure(pollenStates[0], "C")).toBe("grass pollen");
  });

  it("breaks a pollen run on a GAP in the cached series", () => {
    // Same reset heatwave and AQI have: a day inside the hysteresis band holds the run
    // only when the preceding day is actually in the series.
    const contiguous = series("2026-05-01", [
      { pollenGrass: POLLEN_ENTER.grass + 5 },
      { pollenGrass: (POLLEN_ENTER.grass + POLLEN_EXIT.grass) / 2 },
    ]);
    expect(on(contiguous, "2026-05-02")).toContain(
      BUILTIN_HIGH_POLLEN_SITUATION
    );

    const gapped = [
      day("2026-05-01", { pollenGrass: POLLEN_ENTER.grass + 5 }),
      // 2026-05-02 missing.
      day("2026-05-03", {
        pollenGrass: (POLLEN_ENTER.grass + POLLEN_EXIT.grass) / 2,
      }),
    ];
    expect(on(gapped, "2026-05-01")).toContain(BUILTIN_HIGH_POLLEN_SITUATION);
    expect(on(gapped, "2026-05-03")).not.toContain(
      BUILTIN_HIGH_POLLEN_SITUATION
    );
  });

  it("does not fire a family below its own entry bound", () => {
    // A tree-pollen count that would be 'high' for grass is unremarkable for trees —
    // which is exactly why the thresholds are per family.
    const days = series("2026-05-01", [{ pollenTree: POLLEN_ENTER.grass + 5 }]);
    expect(on(days, "2026-05-01")).not.toContain(BUILTIN_HIGH_POLLEN_SITUATION);
  });

  it("holds through the AQI hysteresis band and releases below it", () => {
    const days = series("2026-09-01", [
      { aqi: AQI_ENTER + 20 },
      { aqi: (AQI_ENTER + AQI_EXIT) / 2 },
      { aqi: AQI_EXIT - 10 },
    ]);
    expect(on(days, "2026-09-01")).toContain(BUILTIN_POOR_AIR_SITUATION);
    expect(on(days, "2026-09-02")).toContain(BUILTIN_POOR_AIR_SITUATION);
    expect(on(days, "2026-09-03")).not.toContain(BUILTIN_POOR_AIR_SITUATION);
  });

  it("does not enter from inside the band alone", () => {
    const days = series("2026-09-01", [
      { aqi: (AQI_ENTER + AQI_EXIT) / 2 },
      { aqi: (AQI_ENTER + AQI_EXIT) / 2 },
    ]);
    expect(on(days, "2026-09-02")).not.toContain(BUILTIN_POOR_AIR_SITUATION);
  });

  it("stays silent when the air-quality half of the fetch was missing", () => {
    // The partial-fetch case: temperature present, AQI/pollen absent.
    const days = tempSeries("2026-09-01", [22, 21, 23]);
    expect(on(days, "2026-09-02")).toEqual([]);
  });
});

describe("impact windows from the cached series (#1726 payoff 2)", () => {
  it("collapses a contiguous spell into one window", () => {
    const days = tempSeries("2026-07-01", [35, 35, 35, 35, 20, 20]);
    expect(weatherSituationWindows(days, BUILTIN_HEATWAVE_SITUATION)).toEqual([
      { start: "2026-07-01", end: "2026-07-04" },
    ]);
  });

  it("returns one window per separate spell", () => {
    const days = tempSeries("2026-07-01", [35, 35, 35, 20, 20, 20, 34, 34, 34]);
    expect(weatherSituationWindows(days, BUILTIN_HEATWAVE_SITUATION)).toEqual([
      { start: "2026-07-01", end: "2026-07-03" },
      { start: "2026-07-07", end: "2026-07-09" },
    ]);
  });

  it("returns nothing when the situation never held", () => {
    const days = tempSeries("2026-07-01", [20, 21, 22]);
    expect(weatherSituationWindows(days, BUILTIN_HEATWAVE_SITUATION)).toEqual(
      []
    );
  });
});

describe("notable days + formatters (#1726/#1728)", () => {
  it("calls a day notable exactly when a situation holds", () => {
    const days = tempSeries("2026-07-01", [35, 35, 35, 20]);
    expect(isNotableWeatherDay(days, "2026-07-03")).toBe(true);
    expect(isNotableWeatherDay(days, "2026-07-04")).toBe(false);
    expect(notableDaySummary(days, "2026-07-04")).toBeNull();
    expect(notableDaySummary(days, "2026-07-03")).toBe(
      BUILTIN_HEATWAVE_SITUATION
    );
  });

  it("formats the same summary from an INDEXED evaluation as from a per-day call", () => {
    // #1749: a page rendering many days evaluates the series once and reads byDate per
    // row. That indexed path must be indistinguishable from the one-off accessor —
    // otherwise the Timeline and the one-off callers could disagree about a day.
    const days = series("2026-07-01", [
      { tempMaxC: 35, aqi: AQI_ENTER + 20 },
      { tempMaxC: 35, aqi: AQI_ENTER + 20 },
      { tempMaxC: 35, aqi: AQI_EXIT - 5 },
      { tempMaxC: 20, pollenGrass: POLLEN_ENTER.grass + 5 },
      { tempMaxC: 20 },
    ]);
    const evaluated = evaluateSeries(days);
    for (const d of days) {
      expect(notableStatesSummary(evaluated.byDate.get(d.date) ?? [])).toBe(
        notableDaySummary(days, d.date)
      );
    }
    // …and it really is exercising both the notable and the quiet branch.
    expect(notableDaySummary(days, "2026-07-01")).toBe(
      `${BUILTIN_HEATWAVE_SITUATION} · ${BUILTIN_POOR_AIR_SITUATION}`
    );
    expect(notableDaySummary(days, "2026-07-05")).toBeNull();
  });

  it("renders ambient temperature in the login's scale", () => {
    expect(fmtAmbientTemp(32, "C")).toBe("32°C");
    expect(fmtAmbientTemp(32, "F")).toBe("90°F");
    expect(fmtAmbientTemp(null, "C")).toBeNull();
  });

  it("names the figure per situation", () => {
    const heat = tempSeries("2026-07-01", [
      HEATWAVE_ENTER_C + 2,
      HEATWAVE_ENTER_C + 2,
      HEATWAVE_ENTER_C + 2,
    ]);
    const heatState = evaluateWeatherSituations(heat, "2026-07-03")[0];
    expect(weatherSituationFigure(heatState, "C")).toBe(
      `${HEATWAVE_ENTER_C + 2}°C`
    );

    const swing = series("2026-03-01", [
      { pressureMslHpa: 1015 },
      { pressureMslHpa: 1000 },
    ]);
    const swingState = evaluateWeatherSituations(swing, "2026-03-02")[0];
    // A real minus glyph, and the FALL direction is preserved.
    expect(weatherSituationFigure(swingState, "C")).toBe("−15 hPa");
  });

  it("renders a state line only when something is keyed to the situation", () => {
    const days = tempSeries("2026-07-01", [35, 35, 35]);
    const state = evaluateWeatherSituations(days, "2026-07-03")[0];
    expect(
      weatherSituationStateLine({ state, figure: "35°C", itemCount: 0 })
    ).toBeNull();
    expect(
      weatherSituationStateLine({ state, figure: "35°C", itemCount: 2 })
    ).toBe("Heatwave (35°C) — 2 items active (auto)");
    // A missing figure degrades to a line with no number, never a wrong one.
    expect(
      weatherSituationStateLine({ state, figure: null, itemCount: 1 })
    ).toBe("Heatwave — 1 item active (auto)");
  });

  it("orders concurrent situations stably", () => {
    const days = series("2026-07-01", [
      { tempMaxC: 35, aqi: AQI_ENTER + 30 },
      { tempMaxC: 35, aqi: AQI_ENTER + 30 },
      { tempMaxC: 35, aqi: AQI_ENTER + 30 },
    ]);
    expect(on(days, "2026-07-03")).toEqual([
      BUILTIN_HEATWAVE_SITUATION,
      BUILTIN_POOR_AIR_SITUATION,
    ]);
  });

  it("has a heatwave run length that is at least the cold-snap one", () => {
    // Documents the deliberate asymmetry: a hard freeze changes behavior faster than
    // heat, so the cold snap enters sooner.
    expect(COLD_SNAP_MIN_DAYS).toBeLessThanOrEqual(HEATWAVE_MIN_DAYS);
  });
});
