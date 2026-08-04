import { describe, expect, it } from "vitest";
import {
  parseOpenMeteoHourly,
  parseOpenMeteoDaily,
  parseOpenMeteoAirQuality,
  mergeDailyRows,
  chooseEndpoint,
  ARCHIVE_LAG_DAYS,
} from "../integrations/open-meteo";

// A synthetic Open-Meteo hourly response (both forecast + archive share this shape).
const FIXTURE = {
  latitude: 40.7,
  longitude: -74,
  timezone: "America/New_York",
  hourly: {
    time: ["2026-07-20T10:00", "2026-07-20T11:00", "2026-07-20T12:00"],
    uv_index: [3.2, 6.1, 7.4],
    uv_index_clear_sky: [3.5, 6.4, 7.8],
    shortwave_radiation: [420.0, 610.0, 720.0],
    direct_radiation: [300.0, 480.0, 560.0],
    diffuse_radiation: [120.0, 130.0, 160.0],
    precipitation: [0.0, 2.4, 0.1],
  },
};

describe("parseOpenMeteoHourly", () => {
  it("parses time + all UV/irradiance/precipitation columns into rows", () => {
    const rows = parseOpenMeteoHourly(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({
      hourTs: "2026-07-20T11:00",
      uvIndex: 6.1,
      uvIndexClearSky: 6.4,
      shortwaveRadiation: 610.0,
      directRadiation: 480.0,
      diffuseRadiation: 130.0,
      precipitationMm: 2.4,
    });
  });

  it("normalizes the time to a top-of-hour key", () => {
    const rows = parseOpenMeteoHourly({
      hourly: { time: ["2026-07-20T11:30"], uv_index: [5] },
    });
    expect(rows[0].hourTs).toBe("2026-07-20T11:00");
  });

  it("tolerates a missing variable array (field → null)", () => {
    const rows = parseOpenMeteoHourly({
      hourly: { time: ["2026-07-20T10:00"], uv_index: [4] },
    });
    expect(rows[0].uvIndex).toBe(4);
    expect(rows[0].uvIndexClearSky).toBeNull();
    expect(rows[0].shortwaveRadiation).toBeNull();
    // Precipitation (#1967) degrades the same way: a hour the provider didn't return it
    // for is null, and the wet-park description then renders no timing at all.
    expect(rows[0].precipitationMm).toBeNull();
  });

  it("returns [] for a body with no hourly.time", () => {
    expect(parseOpenMeteoHourly({})).toEqual([]);
    expect(parseOpenMeteoHourly(null)).toEqual([]);
    expect(parseOpenMeteoHourly({ hourly: {} })).toEqual([]);
  });

  it("skips a non-numeric UV value as null (keeps the row)", () => {
    const rows = parseOpenMeteoHourly({
      hourly: { time: ["2026-07-20T10:00"], uv_index: [null] },
    });
    expect(rows[0].uvIndex).toBeNull();
  });
});

describe("chooseEndpoint — archive vs forecast by date", () => {
  const today = "2026-07-20";
  it("uses the forecast endpoint for recent/future dates", () => {
    expect(chooseEndpoint(today, today)).toBe("forecast");
    expect(chooseEndpoint("2026-07-25", today)).toBe("forecast");
    // Within the archive lag → still forecast (archive doesn't have it yet).
    expect(chooseEndpoint("2026-07-16", today)).toBe("forecast");
  });

  it("uses the historical archive for dates older than the lag", () => {
    // 10 days ago is safely older than ARCHIVE_LAG_DAYS.
    expect(ARCHIVE_LAG_DAYS).toBeGreaterThan(0);
    expect(chooseEndpoint("2026-07-01", today)).toBe("archive");
  });
});

// ---- The DAILY substrate (#1726) ---------------------------------------------------

// A synthetic daily response: the `daily` block the forecast/archive endpoints publish,
// plus the hourly `pressure_msl` column the parser means per local day (Open-Meteo has
// no daily pressure aggregate).
const DAILY_FIXTURE = {
  daily: {
    time: ["2026-07-20", "2026-07-21"],
    temperature_2m_max: [33.4, 29.1],
    temperature_2m_min: [21.0, 19.5],
    precipitation_sum: [0, 4.2],
    weather_code: [0, 61],
    uv_index_max: [8.1, 4.4],
  },
  hourly: {
    time: [
      "2026-07-20T00:00",
      "2026-07-20T12:00",
      "2026-07-21T00:00",
      "2026-07-21T12:00",
    ],
    pressure_msl: [1012, 1016, 1000, 1004],
  },
};

// The air-quality endpoint is a separate host with hourly-only variables; the parser
// reduces each day to its PEAK, because "was pollen high that day" is a question about
// the day's worst hour.
const AIR_FIXTURE = {
  hourly: {
    time: ["2026-07-20T08:00", "2026-07-20T15:00", "2026-07-21T08:00"],
    us_aqi: [42, 118, 30],
    birch_pollen: [10, 12, 0],
    alder_pollen: [95, 20, 0],
    grass_pollen: [3, 8, 1],
    ragweed_pollen: [0, 0, 0],
    mugwort_pollen: [null, null, null],
  },
};

describe("parseOpenMeteoDaily (#1726)", () => {
  it("parses the daily block and means hourly pressure per local day", () => {
    const rows = parseOpenMeteoDaily(DAILY_FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-07-20",
      tempMaxC: 33.4,
      tempMinC: 21.0,
      precipitationMm: 0,
      weatherCode: 0,
      uvIndexMax: 8.1,
    });
    // (1012 + 1016) / 2 and (1000 + 1004) / 2 — a MEAN, so one gusty hour can't read as
    // a front passing through.
    expect(rows[0].pressureMslHpa).toBe(1014);
    expect(rows[1].pressureMslHpa).toBe(1002);
  });

  it("tolerates a body with only one of the two blocks", () => {
    expect(
      parseOpenMeteoDaily({ daily: DAILY_FIXTURE.daily })[0].pressureMslHpa
    ).toBeNull();
    const pressureOnly = parseOpenMeteoDaily({ hourly: DAILY_FIXTURE.hourly });
    expect(pressureOnly).toHaveLength(2);
    expect(pressureOnly[0].tempMaxC).toBeNull();
  });

  it("returns nothing for an empty or malformed body", () => {
    expect(parseOpenMeteoDaily({})).toEqual([]);
    expect(parseOpenMeteoDaily(null)).toEqual([]);
    expect(parseOpenMeteoDaily({ daily: { time: "nope" } })).toEqual([]);
  });

  it("skips a non-date row rather than emitting a junk key", () => {
    const rows = parseOpenMeteoDaily({
      daily: {
        time: ["2026-07-20", "not-a-date"],
        temperature_2m_max: [30, 31],
      },
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-07-20"]);
  });
});

describe("parseOpenMeteoAirQuality (#1726)", () => {
  it("reduces hourly readings to the day's peak, per pollen FAMILY", () => {
    const rows = parseOpenMeteoAirQuality(AIR_FIXTURE);
    expect(rows.map((r) => r.date)).toEqual(["2026-07-20", "2026-07-21"]);
    expect(rows[0].aqi).toBe(118);
    // Tree = max(birch, alder, olive) across the day → alder's 95, not birch's 12.
    expect(rows[0].pollenTree).toBe(95);
    expect(rows[0].pollenGrass).toBe(8);
    // Every weed species reported zero — a real reading of zero, not absence.
    expect(rows[0].pollenWeed).toBe(0);
  });

  it("leaves a family null when the provider reported nothing for it", () => {
    const rows = parseOpenMeteoAirQuality({
      hourly: { time: ["2026-07-20T08:00"], us_aqi: [55] },
    });
    expect(rows[0].aqi).toBe(55);
    expect(rows[0].pollenTree).toBeNull();
    expect(rows[0].pollenGrass).toBeNull();
    expect(rows[0].pollenWeed).toBeNull();
  });

  it("returns nothing for an empty body", () => {
    expect(parseOpenMeteoAirQuality({})).toEqual([]);
  });
});

describe("mergeDailyRows (#1726)", () => {
  it("merges the two halves without either overwriting the other's fields", () => {
    const merged = mergeDailyRows(
      parseOpenMeteoDaily(DAILY_FIXTURE),
      parseOpenMeteoAirQuality(AIR_FIXTURE)
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      date: "2026-07-20",
      tempMaxC: 33.4,
      aqi: 118,
      pollenTree: 95,
    });
  });

  it("still yields a row for a date present in only one half", () => {
    const merged = mergeDailyRows(parseOpenMeteoDaily(DAILY_FIXTURE), [
      {
        date: "2026-07-22",
        tempMaxC: null,
        tempMinC: null,
        pressureMslHpa: null,
        precipitationMm: null,
        weatherCode: null,
        uvIndexMax: null,
        aqi: 90,
        pollenTree: null,
        pollenGrass: null,
        pollenWeed: null,
      },
    ]);
    expect(merged.map((r) => r.date)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
    ]);
    expect(merged[2].aqi).toBe(90);
    expect(merged[2].tempMaxC).toBeNull();
  });
});
