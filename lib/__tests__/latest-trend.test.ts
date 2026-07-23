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
});
