import { describe, it, expect } from "vitest";
import { intensityLevel, buildActiveDaysStrip } from "@/lib/workout-heatmap";

describe("intensityLevel", () => {
  it("maps session count to fixed 0..4 buckets", () => {
    expect(intensityLevel(0)).toBe(0);
    expect(intensityLevel(1)).toBe(1);
    expect(intensityLevel(2)).toBe(2);
    expect(intensityLevel(3)).toBe(3);
    expect(intensityLevel(4)).toBe(4);
    expect(intensityLevel(9)).toBe(4);
  });

  it("treats negative/absent as none", () => {
    expect(intensityLevel(-1)).toBe(0);
  });
});

describe("buildActiveDaysStrip", () => {
  it("builds a literal trailing 14-day strip and totals only that window", () => {
    const strip = buildActiveDaysStrip(
      [
        { date: "2025-01-01", count: 5, minutes: 300 },
        { date: "2025-01-02", count: 1, minutes: 30 },
        { date: "2025-01-15", count: 2, minutes: 60 },
      ],
      "2025-01-15"
    );

    expect(strip.days).toHaveLength(14);
    expect(strip.days[0].date).toBe("2025-01-02");
    expect(strip.days.at(-1)?.date).toBe("2025-01-15");
    expect(strip.totalSessions).toBe(3);
    expect(strip.activeDays).toBe(2);
    expect(strip.totalMinutes).toBe(90);
  });
});
