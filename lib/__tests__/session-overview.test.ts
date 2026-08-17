import { describe, expect, it } from "vitest";
import {
  sessionFormRollup,
  sessionOverviewRollup,
} from "@/lib/session-overview";

describe("sessionFormRollup", () => {
  it("compares adjacent rolling blocks for any session domain", () => {
    const result = sessionFormRollup(
      [
        { date: "2026-08-17", durationMin: 60, distanceKm: 10 },
        { date: "2026-08-01", durationMin: 30, distanceKm: 5 },
        { date: "2026-07-10", durationMin: 45, distanceKm: 10 },
      ],
      "2026-08-17",
      28
    );
    expect(result.recent).toEqual({
      sessions: 2,
      durationMin: 90,
      distanceKm: 15,
    });
    expect(result.previous.sessions).toBe(1);
    expect(result.durationChangePercent).toBe(100);
    expect(result.distanceChangePercent).toBe(50);
  });
});

describe("sessionOverviewRollup", () => {
  it("adds shared totals and records with deterministic tie-breaking", () => {
    const result = sessionOverviewRollup(
      [
        {
          id: 1,
          title: "Earlier 10k",
          date: "2026-07-10",
          durationMin: 60,
          distanceKm: 10,
          avgSpeedKmh: null,
        },
        {
          id: 2,
          title: "Latest 10k",
          date: "2026-08-17",
          durationMin: 60,
          distanceKm: 10,
          avgSpeedKmh: null,
        },
      ],
      "2026-08-17",
      28
    );

    expect(result.totals).toEqual({
      sessions: 2,
      durationMin: 120,
      distanceKm: 20,
      averageSpeedKmh: 10,
    });
    expect(
      Object.fromEntries(
        result.records.map((record) => [record.key, record.activityId])
      )
    ).toEqual({ distance: 2, speed: 2, duration: 2 });
  });
});
