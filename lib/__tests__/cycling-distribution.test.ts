import { describe, expect, it } from "vitest";
import { cyclingDistribution } from "@/lib/cycling-distribution";
import type { WeatherDay } from "@/lib/weather-situations";

function weatherDay(
  date: string,
  weatherCode: number,
  tempMaxC = 22,
  precipitationMm = 0
): WeatherDay {
  return {
    date,
    tempMaxC,
    tempMinC: tempMaxC - 8,
    pressureMslHpa: null,
    precipitationMm,
    weatherCode,
    uvIndexMax: null,
    aqi: null,
    pollenTree: null,
    pollenGrass: null,
    pollenWeed: null,
  };
}

function dateSequence(start: string, count: number): string[] {
  const date = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + index);
    return next.toISOString().slice(0, 10);
  });
}

describe("cyclingDistribution", () => {
  it("normalizes month and season counts and keeps true zero months visible", () => {
    const rides = [
      "2024-06-10",
      "2024-07-10",
      "2024-08-10",
      "2024-09-10",
      "2024-10-10",
      "2024-11-10",
      "2025-03-10",
      "2025-04-10",
      "2025-05-10",
      "2025-06-10",
      "2025-07-10",
      "2025-08-01",
    ].map((date) => ({ date }));

    const result = cyclingDistribution(rides, [], "2025-08-04");

    expect(result.observedCalendarMonths).toBe(15);
    expect(result.months.find((month) => month.label === "June")).toMatchObject(
      {
        rides: 2,
        observedMonths: 2,
        ridesPerObservedMonth: 1,
      }
    );
    expect(
      result.months.find((month) => month.label === "January")
    ).toMatchObject({
      rides: 0,
      observedMonths: 1,
    });
    expect(
      result.seasons.find((season) => season.key === "winter")
    ).toMatchObject({
      rides: 0,
      observedMonths: 3,
      percent: 0,
    });
    expect(result.longestQuietPeriod).toEqual({
      startMonth: "2024-12",
      endMonth: "2025-02",
      months: 3,
    });
    expect(result.highlights).toContain(
      "No winter rides across 3 observed winter months."
    );
  });

  it("compares ride-day rates against weather opportunities", () => {
    const dates = dateSequence("2026-01-01", 60);
    const clearRideDates = [dates[0], dates[1], dates[2], dates[3]];
    const cloudyRideDates = [dates[20], dates[21]];
    const temperatures = [8, 15, 25, 32];
    const weather = dates.map((date, index) =>
      weatherDay(date, index < 20 ? 0 : 3, index < 4 ? temperatures[index] : 25)
    );

    const result = cyclingDistribution(
      [...clearRideDates, ...cloudyRideDates].map((date) => ({ date })),
      weather,
      "2026-03-01"
    );

    expect(result.weather).toMatchObject({
      coverageDays: 60,
      coveredRideDays: 6,
      insight: "You ride 4× as often on clear days as on other days.",
    });
    expect(
      result.weather.conditions.find((condition) => condition.key === "clear")
    ).toMatchObject({ availableDays: 20, rideDays: 4, rideDayRate: 20 });
    expect(
      result.weather.conditions.find((condition) => condition.key === "cloudy")
    ).toMatchObject({ availableDays: 40, rideDays: 2, rideDayRate: 5 });
    expect(result.weather.temperatureBands).toEqual([
      { key: "cold", label: "Below 10°C", rideDays: 1, percent: 17 },
      { key: "cool", label: "10–19°C", rideDays: 1, percent: 17 },
      { key: "warm", label: "20–29°C", rideDays: 3, percent: 50 },
      { key: "hot", label: "30°C+", rideDays: 1, percent: 17 },
    ]);
  });

  it("does not infer a weather preference from sparse coverage", () => {
    const dates = dateSequence("2026-06-01", 10);
    const result = cyclingDistribution(
      [{ date: dates[0] }],
      dates.map((date) => weatherDay(date, 0)),
      "2026-06-10"
    );

    expect(result.weather.coverageDays).toBe(10);
    expect(result.weather.insight).toBeNull();
  });
});
