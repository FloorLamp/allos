import { describe, it, expect } from "vitest";
import { weekStartsInclusive, weeklyChartWeeks } from "../weekly-fill";

describe("weekStartsInclusive (issue #406)", () => {
  it("enumerates every week-start inclusive, 7-day steps", () => {
    expect(weekStartsInclusive("2026-01-04", "2026-01-25")).toEqual([
      "2026-01-04",
      "2026-01-11",
      "2026-01-18",
      "2026-01-25",
    ]);
  });
  it("returns the single week when first === last", () => {
    expect(weekStartsInclusive("2026-01-04", "2026-01-04")).toEqual([
      "2026-01-04",
    ]);
  });
  it("is empty when last precedes first", () => {
    expect(weekStartsInclusive("2026-01-11", "2026-01-04")).toEqual([]);
  });
});

describe("weeklyChartWeeks (issue #406 — zero-fill gaps)", () => {
  it("fills the gap between two distant data weeks", () => {
    // Train in Jan, pause, resume — the empty weeks must appear so the gap shows.
    const weeks = weeklyChartWeeks(["2026-01-04", "2026-02-15"], 12);
    expect(weeks[0]).toBe("2026-01-04");
    expect(weeks[weeks.length - 1]).toBe("2026-02-15");
    expect(weeks).toContain("2026-01-25"); // a filled empty week in between
    expect(weeks).toEqual(weekStartsInclusive("2026-01-04", "2026-02-15"));
  });
  it("bounds the axis to the last `windowWeeks` weeks (drops older leading weeks)", () => {
    const weeks = weeklyChartWeeks(
      ["2026-01-04", "2026-03-01", "2026-03-08"],
      3
    );
    // windowWeeks=3 ⇒ start two weeks before the last (2026-02-22), so the very
    // old 2026-01-04 bucket is dropped.
    expect(weeks).toEqual(["2026-02-22", "2026-03-01", "2026-03-08"]);
  });
  it("trims leading empties before the first data week", () => {
    // Only one data week; a 12-week window must NOT invent 11 empty leading weeks.
    expect(weeklyChartWeeks(["2026-03-08"], 12)).toEqual(["2026-03-08"]);
  });
  it("is empty when there is no data", () => {
    expect(weeklyChartWeeks([], 12)).toEqual([]);
  });
});
