import { describe, expect, it } from "vitest";
import {
  cyclingActivityName,
  isCyclingActivity,
  rideComparison,
  sessionComparison,
  sessionHeartRateSeries,
  cyclingHighlights,
  type CyclingComparisonInput,
  sessionZoneRows,
  wattsPerKg,
} from "@/lib/session-detail";
import { cyclingActivityPresentation } from "@/lib/cycling-activity";

function comparisonRide(
  overrides: Partial<CyclingComparisonInput> = {}
): CyclingComparisonInput {
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

describe("sessionComparison", () => {
  it("compares non-cycling sessions with the same sparse-metric rules", () => {
    const current = comparisonRide({
      id: 10,
      title: "Tempo Run",
      distance_km: 10,
    });
    const peer = comparisonRide({
      id: 11,
      title: "Tempo Run",
      distance_km: 9.5,
    });
    const result = sessionComparison(current, [current, peer], {
      isPeer: (a, b) => a.title === b.title,
    });
    expect(result?.basis).toBe("distance");
    expect(result?.sessionCount).toBe(1);
    expect(
      result?.metrics.find((metric) => metric.key === "speed")?.median
    ).toBe(20);
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

describe("sessionHeartRateSeries", () => {
  it("keeps a true one-minute timeline and leaves wear gaps empty", () => {
    expect(
      sessionHeartRateSeries(
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
      sessionCount: 3,
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
    ).toMatchObject({ sessionCount: 12 });
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
      sessionCount: 1,
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

    expect(comparison).toMatchObject({ sessionCount: 1 });
    expect(
      comparison!.metrics.find((metric) => metric.key === "power")
    ).toMatchObject({ median: 170 });
  });
});

describe("sessionZoneRows", () => {
  it("builds the five-zone distribution with stable percentages", () => {
    const rows = sessionZoneRows([0, 50, 0, 10, 0]);
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

describe("cyclingHighlights", () => {
  it("selects dominant time-in-zone, real segment results, and drift", () => {
    expect(
      cyclingHighlights({
        zones: sessionZoneRows([0, 50, 0, 10, 0]),
        powerHrDriftPercent: 4.2,
        segments: [
          { prRank: 1, komRank: null },
          { prRank: 2, komRank: 7 },
        ],
      })
    ).toEqual([
      {
        key: "heart_rate_zone",
        label: "Most time in HR zone",
        value: "Zone 2",
        detail: "50 min · 83% of recorded HR",
        tone: "neutral",
        markerColor: expect.any(String),
      },
      {
        key: "segment_results",
        label: "Best efforts",
        value: "1 personal best",
        detail: "1 top-10 leaderboard result",
        tone: "positive",
      },
      {
        key: "efficiency",
        label: "Efficiency",
        value: "+4.2% drift",
        detail: "Fell in the second half",
        tone: "caution",
      },
    ]);
  });

  it("does not invent highlights for sparse rides", () => {
    expect(
      cyclingHighlights({
        zones: sessionZoneRows([0, 0, 0, 0, 0]),
        powerHrDriftPercent: null,
        segments: [],
      })
    ).toEqual([]);
  });
});
