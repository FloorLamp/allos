import { describe, it, expect } from "vitest";
import { latestTrend } from "@/lib/latest-trend";

// Pure-tier: the latest-reading-with-trend helper behind the Latest-vitals card (#1221).

describe("latestTrend", () => {
  it("returns null for an empty series", () => {
    expect(latestTrend([])).toBeNull();
  });

  it("a single reading has no direction (no prior to compare)", () => {
    const t = latestTrend([{ date: "2026-07-20", value: 118 }])!;
    expect(t.value).toBe(118);
    expect(t.date).toBe("2026-07-20");
    expect(t.previousValue).toBeNull();
    expect(t.direction).toBeNull();
  });

  it("reports up/down/flat versus the immediately prior reading", () => {
    const asc = [
      { date: "2026-07-01", value: 120 },
      { date: "2026-07-10", value: 116 },
      { date: "2026-07-20", value: 118 },
    ];
    const t = latestTrend(asc)!;
    expect(t.value).toBe(118);
    expect(t.previousValue).toBe(116);
    expect(t.direction).toBe("up");

    expect(
      latestTrend([
        { date: "a", value: 60 },
        { date: "b", value: 55 },
      ])!.direction
    ).toBe("down");
    expect(
      latestTrend([
        { date: "a", value: 55 },
        { date: "b", value: 55 },
      ])!.direction
    ).toBe("flat");
  });

  // #2303: two readings from ONE sitting are not a direction. Three sequential cuff
  // readings share a date, and the two-point tail then compared reading #3 to reading
  // #2 of a single measurement — "up versus previous blood pressure" for a number that
  // never moved between two days. The DATA survives (previousValue still reports the
  // other reading); only the claim is withdrawn.
  it("withholds the direction when the last two readings share a date", () => {
    const sameVisit = latestTrend([
      { date: "2026-03-08", value: 120 },
      { date: "2026-03-08", value: 118 },
      { date: "2026-03-08", value: 122 },
    ])!;
    expect(sameVisit.value).toBe(122);
    expect(sameVisit.previousValue).toBe(118);
    expect(sameVisit.direction).toBeNull();
  });

  it("still reports a direction when only EARLIER readings share a date", () => {
    const t = latestTrend([
      { date: "2026-03-08", value: 120 },
      { date: "2026-03-08", value: 118 },
      { date: "2026-05-02", value: 126 },
    ])!;
    expect(t.previousValue).toBe(118);
    expect(t.direction).toBe("up");
  });

  it("withholds the direction for an equal same-day pair too (not 'flat')", () => {
    // "flat" is a claim as well — that the reading held steady between two moments the
    // data never separated.
    expect(
      latestTrend([
        { date: "2026-03-08", value: 118 },
        { date: "2026-03-08", value: 118 },
      ])!.direction
    ).toBeNull();
  });
});
