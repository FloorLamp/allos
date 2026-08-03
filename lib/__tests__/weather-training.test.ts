import { describe, expect, it } from "vitest";
import {
  FALLBACK_MAX_PRECIP_MM,
  FALLBACK_MIN_TEMP_C,
  FORECAST_HORIZON_DAYS,
  MIN_REVEALED_SESSIONS,
  MIN_TIMING_HOURS,
  PARK_REASON_QUANTITY,
  WET_HOUR_MM,
  dayPartOfHour,
  deriveEnvelope,
  fallbackEnvelope,
  isLastViableDay,
  parkedDisclosureLine,
  parkedFigure,
  parkedVerdict,
  pickIndoorAlternative,
  planningLine,
  planningWorthSurfacing,
  precipitationPhrase,
  remainingViableDays,
  scanViableDays,
  conditionsStamp,
  weatherCodeLabel,
  type ParkQuantity,
  type ParkReason,
  type PrecipitationHour,
  type SessionWeather,
} from "@/lib/weather-training";
import {
  indoorAlternatives,
  isOutdoorActivity,
} from "@/lib/activities-catalog";
import { shiftDateStr } from "@/lib/date";
import { fmtAmbientTemp, type WeatherDay } from "@/lib/weather-situations";

// Pure tests for weather-aware training (#1724). The property the whole feature turns
// on: TOLERANCE IS REVEALED, NEVER ASSUMED. A winter cyclist must not be parked at 3 °C
// just because the engine thinks 3 °C is cold, and a fair-weather cyclist should be —
// from the same code, differing only in what each person's own history showed.

const TODAY = "2026-01-15";

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

// `n` logged sessions of `activity` at the given temperatures.
function sessions(
  activity: string,
  temps: readonly number[],
  precip: number | null = 0
): SessionWeather[] {
  return temps.map((t, i) => ({
    date: shiftDateStr(TODAY, -(i + 1)),
    activity,
    tempMaxC: t,
    precipitationMm: precip,
    weatherCode: null,
  }));
}

describe("the outdoor catalog flag (#1724)", () => {
  it("flags activities that are outdoors by their nature", () => {
    expect(isOutdoorActivity("Cycling")).toBe(true);
    expect(isOutdoorActivity("trail run")).toBe(true);
    expect(isOutdoorActivity("Open Water Swim")).toBe(true);
  });

  it("leaves AMBIGUOUS names unflagged rather than guessing", () => {
    // A run can happen on a treadmill and a swim in a pool. Guessing would park a
    // session the person was always going to do indoors.
    expect(isOutdoorActivity("Running")).toBe(false);
    expect(isOutdoorActivity("Swimming")).toBe(false);
    expect(isOutdoorActivity("Rowing")).toBe(false);
    expect(isOutdoorActivity("Something Invented")).toBe(false);
  });

  it("maps outdoor activities to indoor stand-ins, best first", () => {
    expect(indoorAlternatives("Cycling")[0]).toBe("Stationary Bike");
    expect(indoorAlternatives("Trail Run")[0]).toBe("Treadmill");
    // Golf has no honest indoor equivalent — an empty list, not a bad suggestion.
    expect(indoorAlternatives("Golf")).toEqual([]);
    expect(indoorAlternatives("Not An Activity")).toEqual([]);
  });
});

describe("tolerance revealed from the profile's own history (#1724)", () => {
  it("the winter cyclist is NOT parked at 3 °C", () => {
    // Rides logged down to 1 °C: this person rides in the cold, and the engine has been
    // shown so. Parking them would be overruling evidence with a guess.
    const winter = sessions("Cycling", [1, 2, 3, 4, 6, 8, 10, 12]);
    const env = deriveEnvelope("Cycling", winter);
    expect(env.revealed).toBe(true);
    expect(
      parkedVerdict("Cycling", day(TODAY, { tempMaxC: 3 }), env).parked
    ).toBe(false);
  });

  it("the fair-weather cyclist IS parked at 3 °C", () => {
    // Same code, same conditions — a different person's history.
    const fairWeather = sessions("Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    const env = deriveEnvelope("Cycling", fairWeather);
    expect(env.revealed).toBe(true);
    const verdict = parkedVerdict("Cycling", day(TODAY, { tempMaxC: 3 }), env);
    expect(verdict).toMatchObject({ parked: true, reason: "cold", value: 3 });
  });

  it("thin history falls back to the permissive constants", () => {
    const thin = sessions("Cycling", [18, 19, 20]);
    expect(thin.length).toBeLessThan(MIN_REVEALED_SESSIONS);
    const env = deriveEnvelope("Cycling", thin);
    expect(env).toMatchObject(fallbackEnvelope("Cycling"));
    // The fallback is deliberately permissive: 3 °C does NOT park a profile the engine
    // knows nothing about — a wrong park is worse than a missed one.
    expect(
      parkedVerdict("Cycling", day(TODAY, { tempMaxC: 3 }), env).parked
    ).toBe(false);
    // Genuinely hostile conditions still do.
    expect(
      parkedVerdict(
        "Cycling",
        day(TODAY, { tempMaxC: FALLBACK_MIN_TEMP_C - 10 }),
        env
      ).parked
    ).toBe(true);
  });

  it("one outlier session does not move the envelope", () => {
    const fairWeather = sessions("Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    const withHeroics = [...fairWeather, ...sessions("Cycling", [-8])];
    const before = deriveEnvelope("Cycling", fairWeather);
    const after = deriveEnvelope("Cycling", withHeroics);
    // The quantile bound barely moves, and 3 °C stays parked — one blizzard ride does
    // not redefine what this person tolerates.
    expect(after.minTempC).toBeGreaterThan(0);
    expect(after.minTempC).toBeGreaterThanOrEqual(before.minTempC - 4);
    expect(
      parkedVerdict("Cycling", day(TODAY, { tempMaxC: 3 }), after).parked
    ).toBe(true);
  });

  it("sessions without weather coverage reveal nothing", () => {
    const uncovered: SessionWeather[] = Array.from({ length: 10 }, (_, i) => ({
      date: shiftDateStr(TODAY, -(i + 1)),
      activity: "Cycling",
      tempMaxC: null,
      precipitationMm: null,
      weatherCode: null,
    }));
    expect(deriveEnvelope("Cycling", uncovered).revealed).toBe(false);
  });

  it("only counts the activity's OWN sessions", () => {
    const mixed = [
      ...sessions("Hiking", [16, 18, 19, 20, 22, 23, 25, 27]),
      ...sessions("Cycling", [2]),
    ];
    expect(deriveEnvelope("Cycling", mixed).revealed).toBe(false);
    expect(deriveEnvelope("Hiking", mixed).revealed).toBe(true);
  });

  it("the rain cyclist's REVEALED wet bound beats the fallback", () => {
    // The precipitation half of the same revealed-tolerance rule (#1724): someone who
    // regularly rides in heavy rain has shown a wet bound well above the assumed one,
    // so the derived quantile — not FALLBACK_MAX_PRECIP_MM — is what a day is judged
    // against. Without this the engine would park a downpour rider on a day they have
    // demonstrably ridden through.
    const rainy: SessionWeather[] = [0, 2, 4, 8, 12, 16, 20, 25].map(
      (mm, i) => ({
        date: shiftDateStr(TODAY, -(i + 1)),
        activity: "Cycling",
        tempMaxC: 12,
        precipitationMm: mm,
        weatherCode: null,
      })
    );
    const env = deriveEnvelope("Cycling", rainy);
    expect(env.revealed).toBe(true);
    expect(env.maxPrecipitationMm).toBeGreaterThan(FALLBACK_MAX_PRECIP_MM);
    expect(env.maxPrecipitationMm).toBe(20);

    // A 22 mm day is far past the FALLBACK bound (which would park it) and inside this
    // person's own demonstrated range plus its margin, so it is NOT parked.
    const wetDay = day(TODAY, { tempMaxC: 12, precipitationMm: 22 });
    expect(
      parkedVerdict("Cycling", wetDay, fallbackEnvelope("Cycling"))
    ).toMatchObject({ parked: true, reason: "wet" });
    expect(parkedVerdict("Cycling", wetDay, env).parked).toBe(false);
    // Past the revealed bound plus its margin, the rain cyclist is parked too.
    expect(
      parkedVerdict(
        "Cycling",
        day(TODAY, { tempMaxC: 12, precipitationMm: 40 }),
        env
      )
    ).toMatchObject({ parked: true, reason: "wet", revealed: true });
  });

  it("keeps the fallback wet bound when the revealed one would be LOWER", () => {
    // Bucketing only ever widens (Math.max against the fallback): a dry-weather
    // profile's near-zero rain history must not narrow the bound into parking a
    // drizzle the engine has no evidence about.
    const dry = sessions("Cycling", [16, 18, 19, 20, 22, 23, 25, 27], 0);
    expect(deriveEnvelope("Cycling", dry).maxPrecipitationMm).toBe(
      FALLBACK_MAX_PRECIP_MM
    );
  });

  it("parks on heat and on rain too, not just cold", () => {
    const env = deriveEnvelope(
      "Cycling",
      sessions("Cycling", [16, 18, 19, 20, 22, 23, 25, 27])
    );
    expect(
      parkedVerdict("Cycling", day(TODAY, { tempMaxC: 40 }), env)
    ).toMatchObject({ parked: true, reason: "hot" });
    expect(
      parkedVerdict(
        "Cycling",
        day(TODAY, { tempMaxC: 20, precipitationMm: 30 }),
        env
      )
    ).toMatchObject({ parked: true, reason: "wet" });
  });
});

describe("what is never parked (#1724)", () => {
  it("an INDOOR or unknown activity is never parked", () => {
    const arctic = day(TODAY, { tempMaxC: -30 });
    expect(parkedVerdict("Treadmill", arctic, null).parked).toBe(false);
    expect(parkedVerdict("Running", arctic, null).parked).toBe(false);
  });

  it("NO WEATHER means no opinion — today's pick is unchanged", () => {
    expect(parkedVerdict("Cycling", null, null).parked).toBe(false);
    // A cached day with no temperature or precipitation reading is the same silence.
    expect(parkedVerdict("Cycling", day(TODAY), null).parked).toBe(false);
  });
});

describe("the alternative is an offer, not a substitution (#1724)", () => {
  it("offers the first mapped alternative the profile can actually do", () => {
    // No spin bike, but a treadmill: cycling falls past Stationary Bike / Spin Class.
    expect(pickIndoorAlternative("Cycling", (c) => c === "Air Bike")).toBe(
      "Air Bike"
    );
    expect(pickIndoorAlternative("Trail Run", (c) => c === "Treadmill")).toBe(
      "Treadmill"
    );
  });

  it("returns null when the profile can do none of them", () => {
    // The caller then falls through to its normal next-best pick — with the disclosure
    // intact, never a silent disappearance.
    expect(pickIndoorAlternative("Cycling", () => false)).toBeNull();
    expect(pickIndoorAlternative("Golf", () => true)).toBeNull();
  });
});

describe("the disclosure always says why (#838/#1724)", () => {
  it("names the reason, the figure and the alternative", () => {
    expect(
      parkedDisclosureLine({
        activity: "Cycling",
        reason: "cold",
        alternative: "Stationary Bike",
        value: -2,
        weatherCode: null,
        temperatureUnit: "C",
      })
    ).toBe(
      // fmtAmbientTemp renders the ASCII hyphen every other ambient-temperature surface
      // shows; the figure is the shared formatter's, not this line's.
      "Too cold for cycling (-2°C) — Stationary Bike instead. Outdoor cycling resumes when it warms up."
    );
  });

  it("still explains itself when there is no alternative", () => {
    const line = parkedDisclosureLine({
      activity: "Cycling",
      reason: "wet",
      alternative: null,
      value: null,
      weatherCode: null,
      temperatureUnit: "C",
    });
    expect(line).toContain("Too wet for cycling");
    expect(line).toContain("resumes when it dries out");
  });

  it("renders the WET park's description, never a temperature (#1967)", () => {
    // The reported line was "Too wet for cycling (45°C)" — 45 mm of rain wearing a
    // temperature unit. The disclosure now formats the figure itself, so no caller is
    // in a position to hand it the wrong one.
    const line = parkedDisclosureLine({
      activity: "Cycling",
      reason: "wet",
      alternative: "Stationary Bike",
      value: 45,
      weatherCode: 65,
      temperatureUnit: "C",
    });
    expect(line).toContain("Too wet for cycling (heavy rain)");
    expect(line).not.toContain("°C");
    expect(line).not.toContain("45");
  });
});

// ---- The figure a park discloses (#1967) --------------------------------------------
//
// THE BUG THIS PINS: every reason's value used to be formatted as an ambient temperature,
// so rainfall in millimetres rendered as "45°C". The table below is one row per REASON —
// a new reason with no unit of its own is a visible gap here, and a compile error at
// PARK_REASON_QUANTITY.

describe("every park reason formats in its OWN unit (#1967)", () => {
  const CASES: {
    reason: ParkReason;
    quantity: ParkQuantity;
    value: number;
    weatherCode: number | null;
    inC: string;
    inF: string;
  }[] = [
    {
      reason: "cold",
      quantity: "temperature",
      value: -2,
      weatherCode: 71,
      inC: "-2°C",
      inF: "28°F",
    },
    {
      reason: "hot",
      quantity: "temperature",
      value: 38,
      weatherCode: 0,
      inC: "38°C",
      inF: "100°F",
    },
    {
      // Millimetres decide the adjective and are never printed; the type comes from the
      // WMO code. The figure is the SAME in both scales — it is not a temperature.
      reason: "wet",
      quantity: "precipitation",
      value: 45,
      weatherCode: 65,
      inC: "heavy rain",
      inF: "heavy rain",
    },
  ];

  it("covers every reason the parking engine can produce", () => {
    expect(CASES.map((c) => c.reason).sort()).toEqual(
      Object.keys(PARK_REASON_QUANTITY).sort()
    );
  });

  for (const c of CASES) {
    it(`formats a ${c.reason} park as a ${c.quantity}`, () => {
      expect(PARK_REASON_QUANTITY[c.reason]).toBe(c.quantity);
      expect(
        parkedFigure({
          reason: c.reason,
          value: c.value,
          weatherCode: c.weatherCode,
          temperatureUnit: "C",
        })
      ).toBe(c.inC);
      // Units belong to the LOGIN: a °F reader sees °F, and a non-temperature figure is
      // unmoved by the preference.
      expect(
        parkedFigure({
          reason: c.reason,
          value: c.value,
          weatherCode: c.weatherCode,
          temperatureUnit: "F",
        })
      ).toBe(c.inF);
    });

    it(`renders no figure at all for a ${c.reason} park with no value`, () => {
      expect(
        parkedFigure({
          reason: c.reason,
          value: null,
          weatherCode: c.reason === "wet" ? c.weatherCode : null,
          temperatureUnit: "C",
        })
      ).toBe(c.reason === "wet" ? "rain" : null);
    });
  }

  it("a wet park never renders a temperature or millimetres — the regression pin", () => {
    for (const unit of ["C", "F"] as const) {
      const figure = parkedFigure({
        reason: "wet",
        value: 45,
        weatherCode: 65,
        temperatureUnit: unit,
      });
      expect(figure).not.toMatch(/°/);
      expect(figure).not.toMatch(/mm/);
      expect(figure).not.toMatch(/45/);
    }
  });

  it("the verdict carries its own quantity, so no consumer has to guess", () => {
    const env = fallbackEnvelope("Cycling");
    expect(
      parkedVerdict("Cycling", day(TODAY, { tempMaxC: -30 }), env)
    ).toMatchObject({ reason: "cold", quantity: "temperature" });
    expect(
      parkedVerdict("Cycling", day(TODAY, { precipitationMm: 60 }), env)
    ).toMatchObject({ reason: "wet", quantity: "precipitation" });
    // Not parked ⇒ no reason and no quantity to speak of.
    expect(
      parkedVerdict("Cycling", day(TODAY, { tempMaxC: 18 }), env)
    ).toMatchObject({ parked: false, reason: null, quantity: null });
  });
});

describe("the precipitation description (#1967)", () => {
  // A full day of cached hours, wet in the given hours only.
  function hours(
    wet: readonly number[],
    mm = 3,
    count = 24
  ): PrecipitationHour[] {
    return Array.from({ length: count }, (_, hour) => ({
      hour,
      precipitationMm: wet.includes(hour) ? mm : 0,
    }));
  }

  it("takes the TYPE from the weather code, across the whole precipitation family", () => {
    const cases: [number, string][] = [
      [55, "drizzle"],
      [65, "rain"],
      [75, "snow"],
      [81, "showers"],
      [85, "snow showers"],
      [95, "thunderstorm"],
    ];
    for (const [code, label] of cases) {
      expect(
        precipitationPhrase({ weatherCode: code, precipitationMm: 18 })
      ).toBe(label);
    }
  });

  it("takes the INTENSITY from the day's total, which is never itself printed", () => {
    expect(precipitationPhrase({ weatherCode: 53, precipitationMm: 4 })).toBe(
      "light drizzle"
    );
    expect(precipitationPhrase({ weatherCode: 63, precipitationMm: 18 })).toBe(
      "rain"
    );
    expect(precipitationPhrase({ weatherCode: 63, precipitationMm: 45 })).toBe(
      "heavy rain"
    );
    // A thunderstorm carries its own intensity — no adjective is added.
    expect(precipitationPhrase({ weatherCode: 95, precipitationMm: 45 })).toBe(
      "thunderstorm"
    );
  });

  it("says nothing at all when the code names no precipitation", () => {
    // Silence over guessing: "Too wet" already carries the fact; without a code there
    // is no honest way to say whether it is rain, snow or a thunderstorm.
    expect(precipitationPhrase({ weatherCode: 0, precipitationMm: 45 })).toBe(
      null
    );
    expect(precipitationPhrase({ weatherCode: 3, precipitationMm: 45 })).toBe(
      null
    );
    expect(
      precipitationPhrase({ weatherCode: null, precipitationMm: 45 })
    ).toBe(null);
  });

  it("names the day-part when the wet hours cluster into one", () => {
    expect(
      precipitationPhrase({
        weatherCode: 65,
        precipitationMm: 45,
        hours: hours([6, 7, 8, 9, 10]),
      })
    ).toBe("heavy rain in the morning");
    expect(
      precipitationPhrase({
        weatherCode: 61,
        precipitationMm: 4,
        hours: hours([19, 20, 21]),
      })
    ).toBe("light rain in the evening");
  });

  it("says NOTHING about timing rather than inventing precision", () => {
    const all = (h: readonly number[]) =>
      precipitationPhrase({
        weatherCode: 65,
        precipitationMm: 45,
        hours: hours(h),
      });
    // All day — no day-part is truer than any other.
    expect(all([...Array(24).keys()])).toBe("heavy rain");
    // Scattered across parts — a cluster it is not.
    expect(all([7, 14, 20])).toBe("heavy rain");
    // Straddling two parts — neither is the answer.
    expect(all([10, 11, 12, 13])).toBe("heavy rain");
    // Overnight belongs to no named part, so it gets no clause.
    expect(all([1, 2, 3])).toBe("heavy rain");
    // Nothing wet in the hourly series at all (a daily total with no hourly detail).
    expect(all([])).toBe("heavy rain");
  });

  it("a PARTIALLY cached day yields no timing — the missing hours might be wet too", () => {
    expect(
      precipitationPhrase({
        weatherCode: 65,
        precipitationMm: 45,
        hours: hours([6, 7, 8], 3, MIN_TIMING_HOURS - 1),
      })
    ).toBe("heavy rain");
    // One more cached hour and the day is complete enough to speak.
    expect(
      precipitationPhrase({
        weatherCode: 65,
        precipitationMm: 45,
        hours: hours([6, 7, 8], 3, MIN_TIMING_HOURS),
      })
    ).toBe("heavy rain in the morning");
  });

  it("a trace hour is not rain", () => {
    const trace = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      precipitationMm: hour === 20 ? WET_HOUR_MM : 0,
    }));
    trace[7].precipitationMm = 4;
    trace[8].precipitationMm = 4;
    // The 20:00 trace does not drag the phrase out of the morning.
    expect(
      precipitationPhrase({
        weatherCode: 65,
        precipitationMm: 45,
        hours: trace,
      })
    ).toBe("heavy rain in the morning");
  });

  it("maps hours to the day-parts people mean", () => {
    expect(dayPartOfHour(8)).toBe("morning");
    expect(dayPartOfHour(14)).toBe("afternoon");
    expect(dayPartOfHour(20)).toBe("evening");
    expect(dayPartOfHour(3)).toBeNull();
    expect(dayPartOfHour(23)).toBeNull();
  });
});

describe("the viable-days scan (#1724 part 5)", () => {
  const env = deriveEnvelope(
    "Cycling",
    sessions("Cycling", [10, 12, 14, 16, 18, 20, 22, 24])
  );
  const week = [1, 2, 3, 4, 5].map((i) => shiftDateStr(TODAY, i));

  it("names the one dry day among five wet ones", () => {
    const forecast = week.map((d, i) =>
      day(d, { tempMaxC: 15, precipitationMm: i === 2 ? 0 : 40 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(scan.viableDates).toEqual([week[2]]);
    expect(scan.bestDate).toBe(week[2]);
    expect(planningWorthSurfacing(scan, 1)).toBe(true);
  });

  it("says nothing when every day is viable — the quiet-day rule", () => {
    const forecast = week.map((d) =>
      day(d, { tempMaxC: 15, precipitationMm: 0 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(scan.viableDates).toHaveLength(week.length);
    expect(planningWorthSurfacing(scan, 1)).toBe(false);
    expect(
      planningLine({
        activity: "Cycling",
        scan,
        sessionsOwed: 1,
        bestDayLabel: "Saturday",
        progressLabel: "cycling 1/2",
      })
    ).toBeNull();
  });

  it("says nothing when NO day is viable", () => {
    const forecast = week.map((d) =>
      day(d, { tempMaxC: 15, precipitationMm: 60 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(scan.bestDate).toBeNull();
    expect(planningWorthSurfacing(scan, 1)).toBe(false);
  });

  it("picks the BEST window, not merely the first acceptable one", () => {
    const forecast = week.map((d, i) =>
      day(d, { tempMaxC: 15, precipitationMm: i === 1 ? 6 : i === 3 ? 0 : 40 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(scan.viableDates).toEqual([week[1], week[3]]);
    expect(scan.bestDate).toBe(week[3]);
  });

  it("truncates past the reliable horizon and hedges rather than committing", () => {
    const far = [1, 2, 9].map((i) => shiftDateStr(TODAY, i));
    const forecast = far.map((d, i) =>
      day(d, { tempMaxC: 15, precipitationMm: i === 0 ? 0 : 40 })
    );
    const scan = scanViableDays("Cycling", TODAY, far, forecast, env);
    expect(scan.truncated).toBe(true);
    // The day past the horizon isn't in the scan at all.
    expect(scan.days.map((d) => d.date)).not.toContain(far[2]);
    expect(FORECAST_HORIZON_DAYS).toBeLessThan(9);
    const line = planningLine({
      activity: "Cycling",
      scan,
      sessionsOwed: 1,
      bestDayLabel: "Friday",
      progressLabel: null,
    });
    expect(line).toContain("so far");
  });

  it("treats a day with NO forecast row as not viable, never as fine", () => {
    const forecast = [day(week[0], { tempMaxC: 15, precipitationMm: 0 })];
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(scan.viableDates).toEqual([week[0]]);
  });

  it("renders the plan line naming the day and the progress", () => {
    const forecast = week.map((d, i) =>
      day(d, { tempMaxC: 15, precipitationMm: i === 4 ? 0 : 40 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(
      planningLine({
        activity: "Cycling",
        scan,
        sessionsOwed: 1,
        bestDayLabel: "Saturday",
        progressLabel: "cycling 1/2",
      })
    ).toBe(
      "This week: Saturday looks like the best window for your cycling (cycling 1/2)."
    );
  });
});

describe("viable days feed the pace math (#1672/#1673 composition)", () => {
  const env = deriveEnvelope(
    "Cycling",
    sessions("Cycling", [10, 12, 14, 16, 18, 20, 22, 24])
  );
  const week = [1, 2, 3].map((i) => shiftDateStr(TODAY, i));

  it("three calendar days with one dry day is pace-tight ON that day", () => {
    const forecast = week.map((d, i) =>
      day(d, { tempMaxC: 15, precipitationMm: i === 0 ? 0 : 50 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    // The pace math must count ONE remaining day, not three — otherwise weather- and
    // pace-awareness contradict each other and the deferral defers past the last dry day.
    expect(remainingViableDays(scan, week.length)).toBe(1);
    expect(isLastViableDay(scan, week[0])).toBe(true);
    expect(isLastViableDay(scan, week[1])).toBe(false);
  });

  it("falls back to the calendar count when there is NO weather data", () => {
    // Weather must never make a target look impossible just because the forecast is
    // missing — silence over guessing, in the direction that doesn't nag. Contrast the
    // all-parked case above, where data EXISTS and the honest answer is zero.
    const scan = scanViableDays("Cycling", TODAY, week, [], env);
    expect(scan.hasForecast).toBe(false);
    expect(remainingViableDays(scan, week.length)).toBe(week.length);
  });

  it("ALL DAYS PARKED yields zero, not the calendar count", () => {
    // The regression this pins. "No forecast" and "forecast says every day is parked"
    // both produce viable=false with an infinite penalty, so an inference over penalties
    // alone treated them alike and returned the CALENDAR count for both — telling the
    // pace math "you have three days" while the weather said none, which is the exact
    // contradiction the composition exists to remove.
    const forecast = week.map((d) =>
      day(d, { tempMaxC: 15, precipitationMm: 80 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(scan.hasForecast).toBe(true);
    expect(scan.viableDates).toEqual([]);
    expect(remainingViableDays(scan, week.length)).toBe(0);
    // And zero must read as STAND DOWN, never as urgency: nothing is viable, so there is
    // no plan to surface and nothing to escalate about.
    expect(planningWorthSurfacing(scan, 1)).toBe(false);
  });

  it("distinguishes a missing forecast from a parked one day by day", () => {
    const forecast = [day(week[0], { tempMaxC: 15, precipitationMm: 80 })];
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    // Day 0 has data and is parked; days 1-2 have no row at all.
    expect(scan.days[0]).toMatchObject({ forecast: true, viable: false });
    expect(scan.days[1]).toMatchObject({ forecast: false, viable: false });
    // Some data exists, so the app has an opinion: zero viable days.
    expect(scan.hasForecast).toBe(true);
    expect(remainingViableDays(scan, week.length)).toBe(0);
  });

  it("is not 'the last viable day' when several remain", () => {
    const forecast = week.map((d) =>
      day(d, { tempMaxC: 15, precipitationMm: 0 })
    );
    const scan = scanViableDays("Cycling", TODAY, week, forecast, env);
    expect(remainingViableDays(scan, week.length)).toBe(3);
    expect(isLastViableDay(scan, week[0])).toBe(false);
  });
});

describe("conditions stamps (#1728)", () => {
  it("stamps an OUTDOOR session with temperature and sky", () => {
    expect(
      conditionsStamp({
        activity: "Cycling",
        tempLabel: "31°C",
        weatherCode: 0,
      })
    ).toBe("31°C · clear");
  });

  it("renders in the login's temperature scale", () => {
    expect(
      conditionsStamp({
        activity: "Trail Run",
        tempLabel: fmtAmbientTemp(31, "F"),
        weatherCode: 61,
      })
    ).toBe("88°F · rain");
  });

  it("gives an INDOOR or unknown activity no stamp — the flag decides", () => {
    expect(
      conditionsStamp({
        activity: "Treadmill",
        tempLabel: "31°C",
        weatherCode: 0,
      })
    ).toBeNull();
    expect(
      conditionsStamp({
        activity: "Running",
        tempLabel: "31°C",
        weatherCode: 0,
      })
    ).toBeNull();
  });

  it("degrades to whichever fact it has, and to nothing when it has neither", () => {
    expect(
      conditionsStamp({
        activity: "Cycling",
        tempLabel: "8°C",
        weatherCode: null,
      })
    ).toBe("8°C");
    expect(
      conditionsStamp({ activity: "Cycling", tempLabel: null, weatherCode: 3 })
    ).toBe("overcast");
    // A cache gap renders NO stamp rather than a stale or invented one.
    expect(
      conditionsStamp({
        activity: "Cycling",
        tempLabel: null,
        weatherCode: null,
      })
    ).toBeNull();
  });

  it("maps WMO codes to the bands people actually say", () => {
    expect(weatherCodeLabel(0)).toBe("clear");
    expect(weatherCodeLabel(2)).toBe("partly cloudy");
    expect(weatherCodeLabel(45)).toBe("fog");
    expect(weatherCodeLabel(65)).toBe("rain");
    expect(weatherCodeLabel(75)).toBe("snow");
    expect(weatherCodeLabel(95)).toBe("thunderstorm");
    expect(weatherCodeLabel(null)).toBeNull();
    expect(weatherCodeLabel(999)).toBeNull();
  });
});
