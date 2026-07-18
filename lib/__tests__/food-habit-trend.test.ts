import { describe, it, expect } from "vitest";
import { foodHabitTrendCells } from "@/lib/food-habit-trend";
import { trailingWeeks } from "@/lib/week-window";

// Pure N-week consistency trend (issue #954): per-week met/short/empty verdicts over
// the trailing weeks, an honest not-applicable cold start for weeks before the target
// existed, and an in-progress (never "failed") current week. Week identity comes from
// trailingWeeks (the shared #223 definition).

// A calendar week starting Sunday. today = Wed 2026-07-08 (an in-progress week whose
// Sunday is 2026-07-05).
const TODAY = "2026-07-08";
const weeks = trailingWeeks(TODAY, "calendar", 0, 4); // oldest-first

describe("foodHabitTrendCells", () => {
  it("classifies met / short / empty for full past weeks, in-progress current week", () => {
    // Per-week counts by week start. Target = 2/week.
    // weeks (oldest→newest): [06-14, 06-21, 06-28, current 07-05..07-08]
    const counts: Record<string, number> = {
      [weeks[0].start]: 3, // met (>=2)
      [weeks[1].start]: 1, // short (>0, <2)
      [weeks[2].start]: 0, // empty
      [weeks[3].start]: 1, // current, not yet met → in-progress
    };
    const cells = foodHabitTrendCells(
      weeks,
      (w) => counts[w.start] ?? 0,
      2,
      "2026-01-01" // created long ago → all applicable
    );
    expect(cells.map((c) => c.verdict)).toEqual([
      "met",
      "short",
      "empty",
      "current",
    ]);
  });

  it("marks the current week met when it already hit target (never 'short')", () => {
    const cells = foodHabitTrendCells(
      weeks,
      (w) => (w.isCurrent ? 5 : 0),
      2,
      "2026-01-01"
    );
    expect(cells[cells.length - 1].verdict).toBe("met");
  });

  it("renders weeks BEFORE the target existed as not-applicable, never misses", () => {
    // Target created inside the newest full week (weeks[2]); the two oldest weeks are
    // entirely before it → na. Nothing logged, but the pre-target weeks must NOT be
    // 'empty'/'short' misses.
    const createdDate = weeks[2].start; // created at the start of that week
    const cells = foodHabitTrendCells(weeks, () => 0, 2, createdDate);
    expect(cells[0].verdict).toBe("na");
    expect(cells[1].verdict).toBe("na");
    expect(cells[2].verdict).toBe("empty"); // applicable, zero → empty
    expect(cells[3].verdict).toBe("current"); // in-progress
    // The honest cold start: only 2 applicable cells here.
    expect(cells.filter((c) => c.verdict !== "na")).toHaveLength(2);
  });

  it("labels each cell with the week range and count (#954 §2.4)", () => {
    const cells = foodHabitTrendCells(
      weeks,
      (w) => (w.isCurrent ? 1 : 2),
      2,
      "2026-01-01"
    );
    // e.g. "Jun 14 – Jun 20 · 2 of 2"
    expect(cells[0].label).toMatch(/·\s2 of 2$/);
    expect(cells[0].label).toContain("–");
    const na = foodHabitTrendCells(weeks, () => 0, 2, weeks[3].start);
    expect(na[0].label).toContain("not tracked yet");
  });
});
