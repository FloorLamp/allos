import { describe, it, expect } from "vitest";
import {
  sunTimes,
  solarElevation,
  formatMinutes,
  tzOffsetHours,
  solarDay,
} from "../sun";

describe("sunTimes — equator on the equinox", () => {
  it("gives a ~12h day centered on ~noon (lng 0, UTC)", () => {
    const t = sunTimes(0, 0, 2024, 3, 20, 0);
    expect(t.polar).toBeNull();
    // ~12 hours of daylight.
    expect(Math.abs(t.dayLengthMin - 720)).toBeLessThan(12);
    // Solar noon near 12:00 local.
    expect(Math.abs(t.solarNoonMin - 720)).toBeLessThan(20);
    // Sunrise ~06:00, sunset ~18:00.
    expect(Math.abs((t.sunriseMin ?? 0) - 360)).toBeLessThan(12);
    expect(Math.abs((t.sunsetMin ?? 0) - 1080)).toBeLessThan(12);
  });
});

describe("sunTimes — seasonal ordering (northern mid-latitude)", () => {
  it("summer solstice day is much longer than winter solstice", () => {
    // NYC ≈ (40.7, -74.0). EDT = -4 in June, EST = -5 in December.
    const summer = sunTimes(40.7, -74, 2024, 6, 20, -4);
    const winter = sunTimes(40.7, -74, 2024, 12, 21, -5);
    expect(summer.dayLengthMin).toBeGreaterThan(890); // ~15h
    expect(winter.dayLengthMin).toBeLessThan(570); // ~9h
    expect(summer.dayLengthMin).toBeGreaterThan(winter.dayLengthMin + 300);
  });

  it("matches NOAA sunrise/sunset for NYC summer solstice within a few minutes", () => {
    const t = sunTimes(40.7128, -74.006, 2024, 6, 20, -4);
    // NOAA: sunrise 05:24, sunset 20:31 (America/New_York, EDT).
    expect(formatMinutes(t.sunriseMin)).toBe("05:25");
    expect(formatMinutes(t.sunsetMin)).toBe("20:31");
  });
});

describe("sunTimes — polar edge cases", () => {
  it("polar night: sun never rises at 85°N in December", () => {
    const t = sunTimes(85, 0, 2024, 12, 21, 0);
    expect(t.polar).toBe("night");
    expect(t.sunriseMin).toBeNull();
    expect(t.sunsetMin).toBeNull();
    expect(t.dayLengthMin).toBe(0);
  });
  it("polar day: sun never sets at 85°N in June", () => {
    const t = sunTimes(85, 0, 2024, 6, 21, 0);
    expect(t.polar).toBe("day");
    expect(t.dayLengthMin).toBe(1440);
  });
});

describe("solarElevation", () => {
  it("is near overhead at solar noon on the equator at equinox", () => {
    const noon = sunTimes(0, 0, 2024, 3, 20, 0).solarNoonMin;
    const el = solarElevation(0, 0, 2024, 3, 20, 0, noon);
    expect(el).toBeGreaterThan(89);
  });
  it("is below the horizon at local midnight (mid-latitude)", () => {
    const el = solarElevation(40.7, -74, 2024, 6, 20, -4, 0);
    expect(el).toBeLessThan(0);
  });
  it("peaks at solar noon and is lower an hour earlier", () => {
    const noon = sunTimes(40.7, -74, 2024, 6, 20, -4).solarNoonMin;
    const atNoon = solarElevation(40.7, -74, 2024, 6, 20, -4, noon);
    const earlier = solarElevation(40.7, -74, 2024, 6, 20, -4, noon - 60);
    expect(atNoon).toBeGreaterThan(earlier);
  });
});

describe("formatMinutes", () => {
  it("formats minutes past midnight as HH:MM", () => {
    expect(formatMinutes(0)).toBe("00:00");
    expect(formatMinutes(325)).toBe("05:25");
    expect(formatMinutes(1231)).toBe("20:31");
  });
  it("wraps out-of-range values into a day and passes null through", () => {
    expect(formatMinutes(1445)).toBe("00:05");
    expect(formatMinutes(-5)).toBe("23:55");
    expect(formatMinutes(null)).toBeNull();
  });
});

describe("tzOffsetHours (Intl-backed, DST-aware)", () => {
  it("resolves DST for America/New_York across the year", () => {
    expect(tzOffsetHours("America/New_York", 2024, 6, 20)).toBe(-4); // EDT
    expect(tzOffsetHours("America/New_York", 2024, 1, 15)).toBe(-5); // EST
  });
  it("handles a half-hour offset (India) and UTC", () => {
    expect(tzOffsetHours("Asia/Kolkata", 2024, 6, 20)).toBe(5.5);
    expect(tzOffsetHours("UTC", 2024, 6, 20)).toBe(0);
  });
  it("returns null for an invalid timezone", () => {
    expect(tzOffsetHours("Not/AZone", 2024, 6, 20)).toBeNull();
  });
});

describe("solarDay (high-level, IANA timezone)", () => {
  it("produces DST-correct sunrise/sunset for a real timezone", () => {
    const day = solarDay(40.7128, -74.006, "2024-06-20", "America/New_York");
    expect(day).not.toBeNull();
    expect(day!.sunrise).toBe("05:25");
    expect(day!.sunset).toBe("20:31");
    expect(day!.polar).toBeNull();
  });
  it("returns null for an unresolvable timezone (degrade gracefully)", () => {
    expect(solarDay(40, -74, "2024-06-20", "Not/AZone")).toBeNull();
  });
  it("returns null for a malformed date", () => {
    expect(solarDay(40, -74, "June 20", "UTC")).toBeNull();
  });
});
