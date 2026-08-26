import { describe, expect, it } from "vitest";
import {
  fitnessWindow,
  fitnessWindowWeeks,
  hasFitnessZoneContent,
} from "@/lib/trends-fitness";

// #1492: Trends → Fitness became the WINDOWED analytics lens, and #3512 retired the
// tab into Training → Analyze. These pin what the surviving mounts still consume —
// the window itself, how many week columns it is worth, and whether Zones & cardio
// has anything to draw. The PR-block, PR-rate and strength-mover coverage that used
// to follow was deleted with its subjects in #3734: it was the only thing importing
// them, and a test is not a caller.

const TODAY = "2026-07-25";

describe("fitnessWindow", () => {
  it("resolves the hub's default 90D window to a closed [from, to] of 90 days", () => {
    const w = fitnessWindow({ from: "2026-04-27", to: TODAY }, TODAY);
    expect(w).toEqual({
      from: "2026-04-27",
      to: TODAY,
      days: 90,
      allTime: false,
    });
  });

  it("treats an empty range as all time, ending today", () => {
    expect(fitnessWindow({}, TODAY)).toEqual({
      from: null,
      to: TODAY,
      days: null,
      allTime: true,
    });
  });

  it("runs an open END to today, and leaves an open START open", () => {
    expect(fitnessWindow({ from: "2026-07-01" }, TODAY)).toMatchObject({
      from: "2026-07-01",
      to: TODAY,
      days: 25,
      allTime: false,
    });
    // `to` alone is a bounded END with no start — everything up to that day.
    expect(fitnessWindow({ to: "2026-06-30" }, TODAY)).toMatchObject({
      from: null,
      to: "2026-06-30",
      days: null,
      allTime: false,
    });
  });

  it("counts a single-day window as one day, not zero", () => {
    expect(fitnessWindow({ from: TODAY, to: TODAY }, TODAY).days).toBe(1);
  });
});

describe("fitnessWindowWeeks", () => {
  it("gives the 90D default ~13 week columns, not a year", () => {
    expect(fitnessWindowWeeks(90)).toBe(13);
  });

  it("caps all time at 12 months of columns", () => {
    expect(fitnessWindowWeeks(null)).toBe(53);
    // A window LONGER than the cap still caps (the heatmap never grows unbounded).
    expect(fitnessWindowWeeks(5 * 365)).toBe(53);
  });

  it("floors a very short window so the weekly charts still read", () => {
    expect(fitnessWindowWeeks(1)).toBe(4);
    expect(fitnessWindowWeeks(7)).toBe(4);
  });

  it("rounds a partial week UP so the window's edge day has a column", () => {
    expect(fitnessWindowWeeks(30)).toBe(5); // 4.28 weeks
    expect(fitnessWindowWeeks(35)).toBe(5);
    expect(fitnessWindowWeeks(36)).toBe(6);
  });
});

describe("hasFitnessZoneContent", () => {
  it("gates the moved section before its discarded cardio aggregate reads", () => {
    expect(
      hasFitnessZoneContent({ model: null, split: { totalMin: 42 } })
    ).toBe(false);
    expect(
      hasFitnessZoneContent({ model: { maxHr: 190 }, split: { totalMin: 0 } })
    ).toBe(false);
    expect(
      hasFitnessZoneContent({ model: { maxHr: 190 }, split: { totalMin: 42 } })
    ).toBe(true);
  });
});
