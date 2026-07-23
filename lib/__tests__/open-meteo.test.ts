import { describe, expect, it } from "vitest";
import {
  parseOpenMeteoHourly,
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
  },
};

describe("parseOpenMeteoHourly", () => {
  it("parses time + all UV/irradiance columns into rows", () => {
    const rows = parseOpenMeteoHourly(FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({
      hourTs: "2026-07-20T11:00",
      uvIndex: 6.1,
      uvIndexClearSky: 6.4,
      shortwaveRadiation: 610.0,
      directRadiation: 480.0,
      diffuseRadiation: 130.0,
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
