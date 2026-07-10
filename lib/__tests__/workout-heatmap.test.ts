import { describe, it, expect } from "vitest";
import {
  intensityLevel,
  heatmapStart,
  buildWorkoutHeatmap,
  type WorkoutDayDensity,
} from "@/lib/workout-heatmap";
import { weekdayOfDateStr, daysBetweenDateStr } from "@/lib/date";

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

describe("heatmapStart", () => {
  it("aligns the top-left cell to the profile's first weekday", () => {
    // end = Wed 2025-01-15; Sunday-start week → last column starts Sun 2025-01-12.
    const s = heatmapStart("2025-01-15", 53, 0);
    expect(weekdayOfDateStr(s)).toBe(0); // Sunday
    // 53 columns back from the last column start (52 weeks = 364 days).
    expect(s).toBe("2024-01-14");
  });

  it("honors a Monday week start", () => {
    const s = heatmapStart("2025-01-15", 53, 1);
    expect(weekdayOfDateStr(s)).toBe(1); // Monday
  });
});

describe("buildWorkoutHeatmap", () => {
  const density: WorkoutDayDensity[] = [
    { date: "2025-01-13", count: 1, minutes: 60 },
    { date: "2025-01-14", count: 2, minutes: 95 },
    { date: "2025-01-15", count: 4, minutes: 30 }, // == end
  ];

  it("builds a full weeks×7 grid ending on the week of `end`", () => {
    const h = buildWorkoutHeatmap(density, "2025-01-15", 53, 0);
    expect(h.columns).toHaveLength(53);
    for (const col of h.columns) expect(col).toHaveLength(7);
    // Last column contains `end`.
    const flatLast = h.columns[52].map((c) => c.date);
    expect(flatLast).toContain("2025-01-15");
  });

  it("places density on the right cells and levels them by count", () => {
    const h = buildWorkoutHeatmap(density, "2025-01-15", 53, 0);
    const all = h.columns.flat();
    const find = (d: string) => all.find((c) => c.date === d)!;
    expect(find("2025-01-13")).toMatchObject({
      count: 1,
      minutes: 60,
      level: 1,
    });
    expect(find("2025-01-14")).toMatchObject({
      count: 2,
      minutes: 95,
      level: 2,
    });
    expect(find("2025-01-15")).toMatchObject({
      count: 4,
      minutes: 30,
      level: 4,
    });
    // A blank day.
    expect(find("2025-01-10")).toMatchObject({
      count: 0,
      level: 0,
      future: false,
    });
  });

  it("aggregates window totals", () => {
    const h = buildWorkoutHeatmap(density, "2025-01-15", 53, 0);
    expect(h.totalSessions).toBe(7);
    expect(h.activeDays).toBe(3);
    expect(h.totalMinutes).toBe(185);
  });

  it("flags trailing days after `end` as future with no data", () => {
    // end = Wed; the current column runs to Saturday → Thu/Fri/Sat are future.
    const h = buildWorkoutHeatmap([], "2025-01-15", 53, 0);
    const future = h.columns.flat().filter((c) => c.future);
    expect(future.length).toBeGreaterThan(0);
    for (const c of future) {
      expect(c.date > "2025-01-15").toBe(true);
      expect(c.count).toBe(0);
      expect(c.level).toBe(0);
    }
    // A density row dated in a future cell must not be counted.
    const h2 = buildWorkoutHeatmap(
      [{ date: "2025-01-18", count: 5, minutes: 500 }],
      "2025-01-15",
      53,
      0
    );
    expect(h2.totalSessions).toBe(0);
  });

  it("emits a month label per new-month column", () => {
    const h = buildWorkoutHeatmap([], "2025-01-15", 53, 0);
    // ~12 distinct months across the year, each labeled once, columns ascending.
    expect(h.monthLabels.length).toBeGreaterThanOrEqual(12);
    const cols = h.monthLabels.map((m) => m.col);
    expect([...cols].sort((a, b) => a - b)).toEqual(cols);
  });

  // DST boundary case (#94 lesson): the grid must stay a contiguous run of
  // calendar days with no skipped or doubled day when the window crosses a DST
  // transition — the UTC-anchored calendar math is what guarantees it.
  it("stays contiguous across a spring-forward (US 2025-03-09) window", () => {
    const h = buildWorkoutHeatmap(
      [{ date: "2025-03-09", count: 2, minutes: 45 }],
      "2025-03-20",
      53,
      0
    );
    const dates = h.columns.flat().map((c) => c.date);
    for (let i = 1; i < dates.length; i++) {
      expect(daysBetweenDateStr(dates[i - 1], dates[i])).toBe(1);
    }
    // The DST-day density lands on exactly one cell, correctly.
    const dst = h.columns.flat().filter((c) => c.date === "2025-03-09");
    expect(dst).toHaveLength(1);
    expect(dst[0]).toMatchObject({ count: 2, minutes: 45, level: 2 });
  });

  it("reorders rows for a Monday week start", () => {
    const h = buildWorkoutHeatmap([], "2025-01-15", 53, 1);
    expect(h.weekdayOrder).toEqual([1, 2, 3, 4, 5, 6, 0]);
    // Every column's top cell is a Monday.
    for (const col of h.columns) expect(weekdayOfDateStr(col[0].date)).toBe(1);
  });
});
