import { describe, expect, it } from "vitest";
import { sessionDistribution } from "@/lib/session-distribution";
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

describe("sessionDistribution", () => {
  it("normalizes month and season counts and keeps true zero months visible", () => {
    const sessions = [
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

    const result = sessionDistribution(sessions, [], "2025-08-04");

    expect(result.observedCalendarMonths).toBe(15);
    expect(result.months.find((month) => month.label === "June")).toMatchObject(
      {
        sessions: 2,
        observedMonths: 2,
        sessionsPerObservedMonth: 1,
      }
    );
    expect(
      result.months.find((month) => month.label === "January")
    ).toMatchObject({
      sessions: 0,
      observedMonths: 1,
    });
    expect(
      result.seasons.find((season) => season.key === "winter")
    ).toMatchObject({
      sessions: 0,
      observedMonths: 3,
      percent: 0,
    });
    expect(result.longestQuietPeriod).toEqual({
      startMonth: "2024-12",
      endMonth: "2025-02",
      months: 3,
    });
    expect(result.highlights).toContain(
      "No winter sessions across 3 observed winter months."
    );
  });

  it("compares session-day rates against weather opportunities", () => {
    const dates = dateSequence("2026-01-01", 60);
    const clearSessionDates = [dates[0], dates[1], dates[2], dates[3]];
    const cloudySessionDates = [dates[20], dates[21]];
    const temperatures = [8, 15, 25, 32];
    const weather = dates.map((date, index) =>
      weatherDay(date, index < 20 ? 0 : 3, index < 4 ? temperatures[index] : 25)
    );

    const result = sessionDistribution(
      [...clearSessionDates, ...cloudySessionDates].map((date) => ({ date })),
      weather,
      "2026-03-01"
    );

    expect(result.weather).toMatchObject({
      coverageDays: 60,
      coveredSessionDays: 6,
      insight: "You train 4× as often on clear days as on other days.",
    });
    expect(
      result.weather.conditions.find((condition) => condition.key === "clear")
    ).toMatchObject({ availableDays: 20, sessionDays: 4, sessionDayRate: 20 });
    expect(
      result.weather.conditions.find((condition) => condition.key === "cloudy")
    ).toMatchObject({ availableDays: 40, sessionDays: 2, sessionDayRate: 5 });
    expect(result.weather.temperatureBands).toEqual([
      { key: "cold", label: "Below 10°C", sessionDays: 1, percent: 17 },
      { key: "cool", label: "10–19°C", sessionDays: 1, percent: 17 },
      { key: "warm", label: "20–29°C", sessionDays: 3, percent: 50 },
      { key: "hot", label: "30°C+", sessionDays: 1, percent: 17 },
    ]);

    const cycling = sessionDistribution(
      [...clearSessionDates, ...cloudySessionDates].map((date) => ({ date })),
      weather,
      "2026-03-01",
      { singular: "ride", plural: "rides", verb: "ride" }
    );
    expect(cycling.weather.insight).toBe(
      "You ride 4× as often on clear days as on other days."
    );
  });

  it("does not infer a weather preference from sparse coverage", () => {
    const dates = dateSequence("2026-06-01", 10);
    const result = sessionDistribution(
      [{ date: dates[0] }],
      dates.map((date) => weatherDay(date, 0)),
      "2026-06-10"
    );

    expect(result.weather.coverageDays).toBe(10);
    expect(result.weather.insight).toBeNull();
  });
});
