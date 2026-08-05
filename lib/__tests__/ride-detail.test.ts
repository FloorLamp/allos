import { describe, expect, it } from "vitest";
import {
  activityDetailHref,
  cyclingActivityName,
  isCyclingActivity,
  rideComparison,
  rideHistoryNeighbors,
  rideHeartRateSeries,
  rideHighlights,
  type RideComparisonInput,
  rideZoneRows,
  wattsPerKg,
} from "@/lib/ride-detail";
import { cyclingActivityPresentation } from "@/lib/cycling-activity";

function comparisonRide(
  overrides: Partial<RideComparisonInput> = {}
): RideComparisonInput {
  return {
    id: 1,
    date: "2026-06-01",
    type: "cardio",
    title: "Ride",
    components: JSON.stringify([{ name: "Cycling", type: "cardio" }]),
    duration_min: 60,
    distance_km: 20,
    avg_speed_kmh: 20,
    avg_hr: 140,
    avg_power_w: 180,
    weighted_avg_power_w: 190,
    avg_cadence: 85,
    elevation_m: 200,
    relative_effort: 60,
    ...overrides,
  };
}

describe("isCyclingActivity", () => {
  it("recognizes structured and legacy cycling activities", () => {
    expect(
      isCyclingActivity({
        type: "cardio",
        title: "Commute",
        components: JSON.stringify([
          {
            name: "Cycling",
            type: "cardio",
            distance_km: 12,
            duration_min: 35,
          },
        ]),
      })
    ).toBe(true);
    expect(
      isCyclingActivity({
        type: "sport",
        title: "Morning Ride",
        components: null,
      })
    ).toBe(true);
  });

  it("keeps cycling subtypes as distinct activity identities", () => {
    expect(
      cyclingActivityName({
        type: "cardio",
        title: "Trail loops",
        components: JSON.stringify([
          { name: "Mountain Biking", type: "cardio" },
        ]),
      })
    ).toBe("Mountain Biking");
    expect(
      cyclingActivityName({
        type: "cardio",
        title: "Studio class",
        components: JSON.stringify([{ name: "Spinning", type: "cardio" }]),
      })
    ).toBe("Spinning");
    expect(cyclingActivityPresentation("Spinning")).toMatchObject({
      indoorOnly: true,
      noun: "session",
    });
    expect(cyclingActivityPresentation("Mountain Biking")).toMatchObject({
      indoorOnly: false,
      noun: "ride",
    });
  });

  it("does not turn unrelated activity types or title substrings into rides", () => {
    expect(
      isCyclingActivity({
        type: "strength",
        title: "Bike warmup",
        components: null,
      })
    ).toBe(false);
    expect(
      isCyclingActivity({
        type: "cardio",
        title: "Pride run",
        components: null,
      })
    ).toBe(false);
  });
});

describe("activityDetailHref", () => {
  it("routes rides to their detail and other activities to the Journal record", () => {
    expect(
      activityDetailHref({
        id: 42,
        type: "cardio",
        title: "Commute",
        components: JSON.stringify([{ name: "Cycling", type: "cardio" }]),
      })
    ).toBe("/training/rides/42");
    expect(
      activityDetailHref({
        id: 43,
        type: "cardio",
        title: "Morning run",
        components: JSON.stringify([{ name: "Running", type: "cardio" }]),
      })
    ).toBe("/training?tab=log#activity-43");
  });
});

describe("wattsPerKg", () => {
  it("normalizes power against the as-of bodyweight", () => {
    expect(wattsPerKg(186, 75)).toBe(2.48);
  });

  it("returns null when power or bodyweight cannot support a ratio", () => {
    expect(wattsPerKg(null, 75)).toBeNull();
    expect(wattsPerKg(186, 0)).toBeNull();
  });
});

describe("rideHeartRateSeries", () => {
  it("keeps a true one-minute timeline and leaves wear gaps empty", () => {
    expect(
      rideHeartRateSeries(
        {
          start: "2026-06-10T08:00",
          end: "2026-06-10T08:04",
        },
        [
          { ts: "2026-06-10T08:00", bpm: 135 },
          { ts: "2026-06-10T08:02", bpm: 160 },
        ]
      )
    ).toEqual([
      { date: "2026-06-10T08:00", value: 135 },
      { date: "2026-06-10T08:01", value: null },
      { date: "2026-06-10T08:02", value: 160 },
      { date: "2026-06-10T08:03", value: null },
    ]);
  });
});

describe("rideComparison", () => {
  it("uses the median of all similarly sized rides and ignores unlike rides", () => {
    const comparison = rideComparison(
      comparisonRide({
        id: 10,
        date: "2026-06-10",
        avg_speed_kmh: 25,
        avg_hr: 148,
        avg_power_w: 210,
      }),
      [
        comparisonRide({
          id: 9,
          date: "2026-06-09",
          distance_km: 18,
          avg_speed_kmh: 22,
          avg_hr: 140,
          avg_power_w: 180,
        }),
        comparisonRide({
          id: 8,
          date: "2026-06-08",
          distance_km: 22,
          avg_speed_kmh: 24,
          avg_hr: 150,
          avg_power_w: 200,
        }),
        comparisonRide({
          id: 7,
          date: "2026-06-07",
          distance_km: 5,
          avg_speed_kmh: 40,
        }),
        comparisonRide({
          id: 11,
          date: "2026-06-11",
          distance_km: 20,
          avg_speed_kmh: 50,
        }),
        comparisonRide({
          id: 6,
          date: "2026-06-06",
          title: "Run",
          components: JSON.stringify([{ name: "Running", type: "cardio" }]),
          distance_km: 20,
          avg_speed_kmh: 30,
        }),
      ]
    );

    expect(comparison).toMatchObject({
      basis: "distance",
      tolerancePercent: 30,
      rideCount: 3,
    });
    expect(
      comparison!.metrics.find((metric) => metric.key === "speed")
    ).toMatchObject({
      key: "speed",
      current: 25,
      median: 24,
      difference: 1,
    });
    expect(
      comparison!.metrics.find((metric) => metric.key === "heart_rate")
    ).toMatchObject({
      key: "heart_rate",
      current: 148,
      median: 140,
      difference: 8,
    });
    expect(
      comparison!.metrics.find((metric) => metric.key === "power")
    ).toMatchObject({
      key: "power",
      current: 210,
      median: 180,
      difference: 30,
    });
    expect(
      comparison!.metrics.find((metric) => metric.key === "speed")!.points
    ).toEqual([
      {
        id: 8,
        date: "2026-06-08",
        title: "Ride",
        value: 24,
        current: false,
      },
      {
        id: 9,
        date: "2026-06-09",
        title: "Ride",
        value: 22,
        current: false,
      },
      {
        id: 10,
        date: "2026-06-10",
        title: "Ride",
        value: 25,
        current: true,
      },
      {
        id: 11,
        date: "2026-06-11",
        title: "Ride",
        value: 50,
        current: false,
      },
    ]);
  });

  it("does not cap a full similar-ride cohort", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      comparisonRide({
        id: index + 20,
        date: `2026-07-${String(index + 1).padStart(2, "0")}`,
      })
    );

    expect(
      rideComparison(comparisonRide({ id: 10, date: "2026-06-10" }), candidates)
    ).toMatchObject({ rideCount: 12 });
  });

  it("falls back to duration and omits metrics without peer overlap", () => {
    const comparison = rideComparison(
      comparisonRide({
        id: 3,
        date: "2026-06-03",
        distance_km: null,
        duration_min: 50,
        avg_speed_kmh: null,
        avg_power_w: 200,
      }),
      [
        comparisonRide({
          id: 2,
          date: "2026-06-02",
          distance_km: null,
          duration_min: 55,
          avg_speed_kmh: null,
          avg_power_w: null,
        }),
      ]
    );

    expect(comparison).not.toBeNull();
    expect(comparison).toMatchObject({
      basis: "duration",
      rideCount: 1,
    });
    expect(comparison!.metrics.some((metric) => metric.key === "power")).toBe(
      false
    );
  });

  it("compares only the same cycling subtype", () => {
    const comparison = rideComparison(comparisonRide({ id: 10 }), [
      comparisonRide({ id: 11, avg_power_w: 170 }),
      comparisonRide({
        id: 12,
        avg_power_w: 400,
        components: JSON.stringify([
          { name: "Mountain Biking", type: "cardio" },
        ]),
      }),
      comparisonRide({
        id: 13,
        avg_power_w: 500,
        components: JSON.stringify([{ name: "Spinning", type: "cardio" }]),
      }),
    ]);

    expect(comparison).toMatchObject({ rideCount: 1 });
    expect(
      comparison!.metrics.find((metric) => metric.key === "power")
    ).toMatchObject({ median: 170 });
  });
});

describe("rideHistoryNeighbors", () => {
  it("returns the nearest cycling rides before and after the current ride", () => {
    const current = comparisonRide({
      id: 10,
      date: "2026-06-10",
      start_time: "08:00",
    });
    const history = rideHistoryNeighbors(current, [
      comparisonRide({ id: 5, date: "2026-06-01" }),
      comparisonRide({ id: 8, date: "2026-06-09" }),
      comparisonRide({ id: 9, date: "2026-06-10", start_time: "07:00" }),
      comparisonRide({ id: 11, date: "2026-06-10", start_time: "09:00" }),
      comparisonRide({ id: 12, date: "2026-06-11" }),
      comparisonRide({
        id: 13,
        date: "2026-06-12",
        title: "Run",
        components: JSON.stringify([{ name: "Running", type: "cardio" }]),
      }),
    ]);

    expect(history.before.map((ride) => ride.id)).toEqual([9, 8, 5]);
    expect(history.after.map((ride) => ride.id)).toEqual([11, 12]);
  });
});

describe("rideZoneRows", () => {
  it("builds the five-zone distribution with stable percentages", () => {
    const rows = rideZoneRows([0, 50, 0, 10, 0]);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toMatchObject({
      name: "Zone 2",
      minutes: 50,
      percent: 83,
    });
    expect(rows[3]).toMatchObject({
      name: "Zone 4",
      minutes: 10,
      percent: 17,
    });
  });
});

describe("rideHighlights", () => {
  it("selects dominant time-in-zone, real segment results, and drift", () => {
    expect(
      rideHighlights({
        zones: rideZoneRows([0, 50, 0, 10, 0]),
        powerHrDriftPercent: 4.2,
        segments: [
          { prRank: 1, komRank: null },
          { prRank: 2, komRank: 7 },
        ],
      })
    ).toEqual([
      {
        key: "heart_rate_zone",
        zone: expect.objectContaining({ name: "Zone 2", percent: 83 }),
      },
      {
        key: "segment_results",
        personalBestCount: 1,
        leaderboardCount: 1,
      },
      { key: "efficiency", driftPercent: 4.2 },
    ]);
  });

  it("does not invent highlights for sparse rides", () => {
    expect(
      rideHighlights({
        zones: rideZoneRows([0, 0, 0, 0, 0]),
        powerHrDriftPercent: null,
        segments: [],
      })
    ).toEqual([]);
  });
});
