import { describe, expect, it } from "vitest";
import { cyclingOverviewRollup } from "@/lib/cycling-overview";

describe("cyclingOverviewRollup", () => {
  const rides = [
    {
      id: 1,
      date: "2026-06-01",
      title: "Earlier base ride",
      durationMin: 60,
      distanceKm: 24,
      avgSpeedKmh: 24,
      elevationM: 200,
      avgPowerW: 180,
      kilojoules: 600,
    },
    {
      id: 2,
      date: "2026-06-20",
      title: "Previous-period ride",
      durationMin: 90,
      distanceKm: 30,
      avgSpeedKmh: 20,
      elevationM: 300,
      avgPowerW: 170,
      kilojoules: 700,
    },
    {
      id: 3,
      date: "2026-08-01",
      title: "Recent long ride",
      durationMin: 100,
      distanceKm: 50,
      avgSpeedKmh: 30,
      elevationM: 600,
      avgPowerW: 220,
      kilojoules: 900,
    },
  ];

  it("builds all-time totals, rolling form, and cycling records", () => {
    const result = cyclingOverviewRollup(rides, "2026-08-04");

    expect(result.totals).toMatchObject({
      rides: 3,
      distanceKm: 104,
      durationMin: 250,
      elevationM: 1100,
      kilojoules: 2200,
    });
    expect(result.totals.averageSpeedKmh).toBeCloseTo(24.96, 2);
    expect(result.recent).toMatchObject({
      rides: 1,
      distanceKm: 50,
      durationMin: 100,
    });
    expect(result.previous).toMatchObject({
      rides: 1,
      distanceKm: 30,
      durationMin: 90,
    });
    expect(result.distanceChangePercent).toBe(67);
    expect(result.durationChangePercent).toBe(11);
    expect(
      Object.fromEntries(
        result.records.map((record) => [record.key, record.rideId])
      )
    ).toEqual({ distance: 3, speed: 3, duration: 3, elevation: 3, power: 3 });
  });

  it("uses the latest ride to break an equal record and omits empty baselines", () => {
    const result = cyclingOverviewRollup(
      [
        rides[0],
        { ...rides[0], id: 4, date: "2026-08-04", title: "Latest tie" },
      ],
      "2026-08-04"
    );

    expect(result.records.every((record) => record.rideId === 4)).toBe(true);
    expect(result.distanceChangePercent).toBeNull();
    expect(result.durationChangePercent).toBeNull();
  });
});
