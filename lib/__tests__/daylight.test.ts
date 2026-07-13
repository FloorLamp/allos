import { describe, it, expect } from "vitest";
import {
  hhmmToMin,
  overlapMinutes,
  daylightWindow,
  activityDaylightMinutes,
  daylightOutdoorMinutes,
} from "../daylight";
import type { SolarDay } from "../sun";

// A normal day: sunrise 06:00 (360), sunset 20:00 (1200).
const DAY: SolarDay = {
  date: "2024-06-20",
  sunrise: "06:00",
  sunset: "20:00",
  solarNoon: "13:00",
  dayLengthMin: 840,
  polar: null,
  sunriseMin: 360,
  sunsetMin: 1200,
};

describe("hhmmToMin", () => {
  it("parses HH:MM", () => {
    expect(hhmmToMin("06:30")).toBe(390);
    expect(hhmmToMin("00:00")).toBe(0);
    expect(hhmmToMin("23:59")).toBe(1439);
  });
  it("rejects garbage", () => {
    expect(hhmmToMin("25:00")).toBeNull();
    expect(hhmmToMin("noon")).toBeNull();
    expect(hhmmToMin(null)).toBeNull();
  });
});

describe("overlapMinutes", () => {
  it("computes clamped interval overlap", () => {
    expect(overlapMinutes(0, 100, 50, 200)).toBe(50);
    expect(overlapMinutes(0, 40, 60, 100)).toBe(0); // disjoint
    expect(overlapMinutes(10, 90, 10, 90)).toBe(80); // identical
  });
});

describe("daylightWindow", () => {
  it("is sunrise→sunset on a normal day", () => {
    expect(daylightWindow(DAY)).toEqual({ start: 360, end: 1200 });
  });
  it("is the whole day on a polar day and empty on a polar night", () => {
    expect(daylightWindow({ ...DAY, polar: "day" })).toEqual({
      start: 0,
      end: 1440,
    });
    expect(daylightWindow({ ...DAY, polar: "night" })).toEqual({
      start: 0,
      end: 0,
    });
  });
  it("is null for no day", () => {
    expect(daylightWindow(null)).toBeNull();
  });
});

describe("activityDaylightMinutes", () => {
  it("counts the overlap for an outdoor midday activity", () => {
    // 12:00–13:00, fully within daylight → 60.
    expect(
      activityDaylightMinutes(
        { startTime: "12:00", endTime: "13:00", outdoor: true },
        DAY
      )
    ).toBe(60);
  });
  it("counts only the daylit portion of an activity that starts before sunrise", () => {
    // 05:30–06:30 with sunrise 06:00 → only 30 min are in daylight.
    expect(
      activityDaylightMinutes(
        { startTime: "05:30", endTime: "06:30", outdoor: true },
        DAY
      )
    ).toBe(30);
  });
  it("is 0 for an indoor activity, even in daylight", () => {
    expect(
      activityDaylightMinutes(
        { startTime: "12:00", endTime: "13:00", outdoor: false },
        DAY
      )
    ).toBe(0);
  });
  it("is 0 without both start and end times", () => {
    expect(
      activityDaylightMinutes(
        { startTime: "12:00", endTime: null, outdoor: true },
        DAY
      )
    ).toBe(0);
  });
  it("counts a whole outdoor activity on a polar day", () => {
    expect(
      activityDaylightMinutes(
        { startTime: "02:00", endTime: "03:00", outdoor: true },
        { ...DAY, polar: "day" }
      )
    ).toBe(60);
  });
});

describe("daylightOutdoorMinutes", () => {
  it("sums across a day's outdoor activities", () => {
    const total = daylightOutdoorMinutes(
      [
        { startTime: "07:00", endTime: "08:00", outdoor: true }, // 60
        { startTime: "12:00", endTime: "12:30", outdoor: true }, // 30
        { startTime: "13:00", endTime: "14:00", outdoor: false }, // 0 (indoor)
      ],
      DAY
    );
    expect(total).toBe(90);
  });
});
