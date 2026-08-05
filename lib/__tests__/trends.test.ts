import { describe, expect, it } from "vitest";
import {
  filterSeriesByRange,
  outOfWindowAgeLabel,
  outOfWindowLatest,
  rangeSummaryLabel,
} from "../trends";
import {
  ALL_TIME_RANGE_VALUE,
  defaultTrendsRange,
  intradayQuickRange,
  isAllTimeRange,
  isCustomRange,
  isIntradayRange,
  isQuickRangeActive,
  quickRanges,
  resolveTrendsRange,
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

// The `summarizeSeries` suite that used to live here is gone with the function
// (#2044): it read direction off the LITERAL first/last points, had zero non-test
// callers, and documented a second — unsafe — semantics for the one question
// `robustSeriesSummary` answers. Its surviving behavior (null for an
// empty/insufficient series, null gaps skipped, up/down/flat direction) is covered by
// the robustSeriesSummary suite in trends-digest.test.ts.

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

  // The ONE predicate behind both the mobile From/To panel's default-open state
  // and the range-summary chip's visibility (#1455 A + D) — a window no chip in
  // the row already names.
  describe("isCustomRange", () => {
    it("is false for every window a pill already names", () => {
      expect(isCustomRange({}, today)).toBe(false); // All time
      for (const qr of quickRanges(today)) {
        expect(isCustomRange({ from: qr.from, to: qr.to }, today)).toBe(false);
      }
    });

    it("is true for a hand-picked window", () => {
      expect(
        isCustomRange({ from: "2026-01-01", to: "2026-02-01" }, today)
      ).toBe(true);
    });

    it("is true for a half-open window, which no pill can express", () => {
      const [seven] = quickRanges(today);
      expect(isCustomRange({ from: seven.from }, today)).toBe(true);
      expect(isCustomRange({ to: today }, today)).toBe(true);
    });

    it("follows today, so yesterday's 7D window reads as custom", () => {
      const [seven] = quickRanges(today);
      // Same bounds, a day later: the pill now means a different window, so the
      // stored one is custom and its dates must stay visible.
      expect(
        isCustomRange({ from: seven.from, to: seven.to }, "2026-07-09")
      ).toBe(true);
    });

    // #1466: a surface may inject extra pills (the Vitals tab's 1D). A window one
    // of THOSE names is not custom either — otherwise lighting 1D would pop the
    // "Custom…" panel open and print a summary chip repeating the lit pill.
    it("counts a surface's extra pills as named windows", () => {
      const oneDay = intradayQuickRange(today);
      expect(isCustomRange({ from: today, to: today }, today)).toBe(true);
      expect(isCustomRange({ from: today, to: today }, today, [oneDay])).toBe(
        false
      );
      // The extras never widen what the SHARED pills name.
      expect(
        isCustomRange({ from: "2026-01-01", to: "2026-02-01" }, today, [oneDay])
      ).toBe(true);
    });
  });

  // The Vitals tab's 1D window (#1466) — deliberately NOT in the shared
  // quickRanges set, because a one-day window is only meaningful on a surface
  // that swaps to intraday content for it.
  describe("intradayQuickRange / isIntradayRange", () => {
    it("is today, inclusive, and is not one of the shared pills", () => {
      expect(intradayQuickRange(today)).toEqual({
        label: "1D",
        from: today,
        to: today,
      });
      expect(quickRanges(today).some((qr) => qr.label === "1D")).toBe(false);
    });

    it("recognizes only the exact single-day-today window", () => {
      expect(isIntradayRange({ from: today, to: today }, today)).toBe(true);
      expect(isIntradayRange({}, today)).toBe(false);
      expect(isIntradayRange({ from: today }, today)).toBe(false);
      // Yesterday's single day is not "today's intraday view".
      expect(
        isIntradayRange({ from: "2026-07-07", to: "2026-07-07" }, today)
      ).toBe(false);
      const [seven] = quickRanges(today);
      expect(isIntradayRange({ from: seven.from, to: seven.to }, today)).toBe(
        false
      );
    });
  });
});

// ---------------------------------------------------------------------------
// #1485 G: Trends opens on 90D, and a sparse series shows its latest reading.
// ---------------------------------------------------------------------------

describe("defaultTrendsRange / resolveTrendsRange", () => {
  const today = "2026-07-08";

  // The whole point of the default is that it LIGHTS a pill: a window that
  // didn't exactly match 90D would render every pill dark and print a "Custom…"
  // summary chip on a plain /trends load.
  it("is exactly the 90D quick range, so that pill renders active", () => {
    const ninety = quickRanges(today).find((q) => q.label === "90D")!;
    expect(defaultTrendsRange(today)).toEqual({
      from: ninety.from,
      to: ninety.to,
    });
    expect(isQuickRangeActive(defaultTrendsRange(today), ninety)).toBe(true);
    // ...and therefore is not "custom" and not "all time".
    expect(isCustomRange(defaultTrendsRange(today), today)).toBe(false);
    expect(isAllTimeRange(defaultTrendsRange(today))).toBe(false);
  });

  it("follows the profile's today", () => {
    expect(defaultTrendsRange(today).from).toBe("2026-04-10"); // 89 days back
    expect(defaultTrendsRange("2026-01-01").from).toBe("2025-10-04");
    expect(defaultTrendsRange("2026-01-01").to).toBe("2026-01-01");
  });

  it("applies the default ONLY when the URL names no window", () => {
    expect(resolveTrendsRange({}, today)).toEqual(defaultTrendsRange(today));
    expect(resolveTrendsRange({}, today, undefined)).toEqual(
      defaultTrendsRange(today)
    );
  });

  // The contract for every shared/bookmarked link: a URL
  // that says something is never reinterpreted.
  it("never rewrites an explicit window", () => {
    const custom = { from: "2026-01-01", to: "2026-02-01" };
    expect(resolveTrendsRange(custom, today)).toEqual(custom);
    // A half-open window keeps its open side open — not silently closed to 90D.
    expect(resolveTrendsRange({ from: "2026-01-01" }, today)).toEqual({
      from: "2026-01-01",
    });
    expect(resolveTrendsRange({ to: "2026-02-01" }, today)).toEqual({
      to: "2026-02-01",
    });
  });

  // Without this sentinel the "All time" pill would be a no-op: it clears the
  // params, and a cleared URL is now the 90D default.
  it("honors the explicit all-time sentinel over the default", () => {
    expect(resolveTrendsRange({}, today, ALL_TIME_RANGE_VALUE)).toEqual({});
    expect(isAllTimeRange(resolveTrendsRange({}, today, "all"))).toBe(true);
    // It outranks stale bounds too, so the pill wins from any prior state.
    expect(
      resolveTrendsRange({ from: "2026-01-01" }, today, ALL_TIME_RANGE_VALUE)
    ).toEqual({});
  });

  it("ignores an unrecognized range param and falls through to the default", () => {
    expect(resolveTrendsRange({}, today, "bogus")).toEqual(
      defaultTrendsRange(today)
    );
    expect(resolveTrendsRange({}, today, "")).toEqual(
      defaultTrendsRange(today)
    );
  });
});

describe("outOfWindowLatest", () => {
  const series = [
    { date: "2024-03-01", value: 1 },
    { date: "2025-06-01", value: 2 },
    { date: "2026-02-01", value: 3 },
  ];

  it("returns the newest reading when the window is empty", () => {
    expect(outOfWindowLatest(series, { from: "2026-05-01" })).toEqual({
      date: "2026-02-01",
      value: 3,
    });
  });

  // The tile draws the real series in this case; a second "latest" line would
  // duplicate the headline value and imply staleness that isn't there.
  it("returns null when the window has any point of its own", () => {
    expect(outOfWindowLatest(series, { from: "2026-01-01" })).toBeNull();
    // Even a single in-window point counts.
    expect(
      outOfWindowLatest(series, { from: "2026-02-01", to: "2026-02-01" })
    ).toBeNull();
    // An all-time window contains everything a non-empty series has.
    expect(outOfWindowLatest(series, {})).toBeNull();
  });

  // A never-measured saved biomarker keeps the #1456 placeholder tile (and its
  // reachable ★) — there is no reading to fall back to.
  it("returns null for an empty series", () => {
    expect(outOfWindowLatest([], { from: "2026-05-01" })).toBeNull();
    expect(outOfWindowLatest([], {})).toBeNull();
  });

  // A window ENTIRELY in the future of the series, and one entirely in its past,
  // both fall back to the newest reading — the tile's job is "the latest value",
  // never "the nearest value".
  it("falls back to the newest reading regardless of which side the window sits on", () => {
    expect(outOfWindowLatest(series, { to: "2024-01-01" })).toEqual({
      date: "2026-02-01",
      value: 3,
    });
  });
});

describe("outOfWindowAgeLabel", () => {
  const today = "2026-07-08";

  // The age is the honesty marker — it is what stops a five-month-old value from
  // reading as today's, so it must be present and correct at every distance.
  it("labels the reading's age compactly", () => {
    expect(outOfWindowAgeLabel("2026-07-01", today)).toBe("1w ago");
    expect(outOfWindowAgeLabel("2026-03-01", today)).toBe("4mo ago");
    expect(outOfWindowAgeLabel("2023-07-08", today)).toBe("3y ago");
  });

  it("never says 'Today ago'", () => {
    expect(outOfWindowAgeLabel(today, today)).toBe("today");
  });
});
