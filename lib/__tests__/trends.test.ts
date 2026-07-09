import { describe, expect, it } from "vitest";
import {
  filterSeriesByRange,
  rangeSummaryLabel,
  summarizeSeries,
} from "../trends";
import {
  isAllTimeRange,
  isQuickRangeActive,
  quickRanges,
} from "../timeline-format";

describe("filterSeriesByRange", () => {
  const series = [
    { date: "2026-01-01", value: 1 },
    { date: "2026-02-01", value: 2 },
    { date: "2026-03-01", value: 3 },
    { date: "2026-04-01", value: 4 },
  ];

  it("returns the series unchanged for an all-time (open) window", () => {
    expect(filterSeriesByRange(series, {})).toBe(series);
  });

  it("keeps points inside an inclusive [from, to] window", () => {
    expect(
      filterSeriesByRange(series, { from: "2026-02-01", to: "2026-03-01" })
    ).toEqual([
      { date: "2026-02-01", value: 2 },
      { date: "2026-03-01", value: 3 },
    ]);
  });

  it("treats a missing bound as open on that side", () => {
    expect(filterSeriesByRange(series, { from: "2026-03-01" })).toEqual([
      { date: "2026-03-01", value: 3 },
      { date: "2026-04-01", value: 4 },
    ]);
    expect(filterSeriesByRange(series, { to: "2026-02-01" })).toEqual([
      { date: "2026-01-01", value: 1 },
      { date: "2026-02-01", value: 2 },
    ]);
  });

  it("returns empty when nothing falls in the window", () => {
    expect(
      filterSeriesByRange(series, { from: "2027-01-01", to: "2027-12-31" })
    ).toEqual([]);
  });
});

describe("summarizeSeries", () => {
  it("returns null for an empty or all-null series", () => {
    expect(summarizeSeries([])).toBeNull();
    expect(summarizeSeries([{ value: null }, { value: null }])).toBeNull();
  });

  it("summarizes first/last/delta and an upward direction", () => {
    expect(
      summarizeSeries([{ value: 10 }, { value: 12 }, { value: 15 }])
    ).toEqual({
      count: 3,
      first: 10,
      last: 15,
      delta: 5,
      direction: "up",
    });
  });

  it("reports a downward direction for a net decrease", () => {
    expect(summarizeSeries([{ value: 20 }, { value: 8 }])?.direction).toBe(
      "down"
    );
  });

  it("reports flat when first equals last and skips null gaps", () => {
    const s = summarizeSeries([{ value: 5 }, { value: null }, { value: 5 }]);
    expect(s).toEqual({
      count: 2,
      first: 5,
      last: 5,
      delta: 0,
      direction: "flat",
    });
  });
});

describe("rangeSummaryLabel", () => {
  const today = "2026-07-08";
  it("labels an all-time window", () => {
    expect(rangeSummaryLabel({}, today)).toBe("All time");
  });
  it("labels a both-bounded window", () => {
    expect(
      rangeSummaryLabel({ from: "2026-01-01", to: "2026-02-01" }, today)
    ).toBe("2026-01-01 → 2026-02-01");
  });
  it("collapses a single-day window", () => {
    expect(rangeSummaryLabel({ from: today, to: today }, today)).toBe(today);
  });
  it("labels an open-ended from window", () => {
    expect(rangeSummaryLabel({ from: "2026-01-01" }, today)).toBe(
      "From 2026-01-01"
    );
  });
  it("labels a through-today window and a through-date window", () => {
    expect(rangeSummaryLabel({ to: today }, today)).toBe("Through today");
    expect(rangeSummaryLabel({ to: "2026-06-01" }, today)).toBe(
      "Through 2026-06-01"
    );
  });
});

describe("quick-range vocabulary (shared with the Timeline)", () => {
  const today = "2026-07-08";
  it("offers 7D / 30D / 90D windows ending today", () => {
    const qr = quickRanges(today);
    expect(qr.map((r) => r.label)).toEqual(["7D", "30D", "90D"]);
    expect(qr.every((r) => r.to === today)).toBe(true);
    expect(qr[0].from).toBe("2026-07-02"); // 6 days back = 7 inclusive days
    expect(qr[1].from).toBe("2026-06-09"); // 29 days back = 30 inclusive days
    expect(qr[2].from).toBe("2026-04-10"); // 89 days back = 90 inclusive days
  });

  it("marks a matching window active and others inactive", () => {
    const [seven] = quickRanges(today);
    expect(isQuickRangeActive({ from: seven.from, to: today }, seven)).toBe(
      true
    );
    expect(isQuickRangeActive({ from: seven.from }, seven)).toBe(false);
    expect(isQuickRangeActive({}, seven)).toBe(false);
  });

  it("recognizes the open all-time window", () => {
    expect(isAllTimeRange({})).toBe(true);
    expect(isAllTimeRange({ from: today })).toBe(false);
    expect(isAllTimeRange({ to: today })).toBe(false);
  });
});
