import { describe, expect, it } from "vitest";
import {
  activeRangeLabel,
  trendsContextLabel,
  TRENDS_CONTEXT_SEPARATOR,
} from "../trends-context";
import {
  defaultTrendsRange,
  intradayQuickRange,
  quickRanges,
} from "../timeline-format";

// The Trends phone chrome's context LABEL (#1485 F). The label is the only part of
// the pill row + tab strip that stays visible once they collapse, so its whole
// contract is: it names the window the charts are drawn over, and it never
// disagrees with the pill the expanded control would light.

const TODAY = "2026-07-26";

describe("activeRangeLabel", () => {
  it("names the lit quick-range pill", () => {
    for (const qr of quickRanges(TODAY)) {
      expect(activeRangeLabel({ from: qr.from, to: qr.to }, TODAY)).toBe(
        qr.label
      );
    }
  });

  it("names the 90D default a no-param load resolves to (#1485 G)", () => {
    // The load-bearing pairing: the paramless default must read as "90D", not as a
    // custom window that happens to be 90 days long.
    expect(activeRangeLabel(defaultTrendsRange(TODAY), TODAY)).toBe("90D");
  });

  it("names the open window All time", () => {
    expect(activeRangeLabel({}, TODAY)).toBe("All time");
  });

  it("names a surface-injected extra range (the Body tab's 1D — #1466)", () => {
    const oneDay = intradayQuickRange(TODAY);
    // Only when the surface offers it: without the extra, the same window has no
    // pill naming it and falls through to the custom summary.
    expect(
      activeRangeLabel({ from: oneDay.from, to: oneDay.to }, TODAY, [oneDay])
    ).toBe("1D");
    expect(activeRangeLabel({ from: oneDay.from, to: oneDay.to }, TODAY)).toBe(
      TODAY
    );
  });

  it("falls back to the shared summary for a custom window", () => {
    expect(
      activeRangeLabel({ from: "2026-01-01", to: "2026-02-01" }, TODAY)
    ).toBe("2026-01-01 → 2026-02-01");
    expect(activeRangeLabel({ from: "2026-01-01" }, TODAY)).toBe(
      "From 2026-01-01"
    );
    expect(activeRangeLabel({ to: TODAY }, TODAY)).toBe("Through today");
  });
});

describe("trendsContextLabel", () => {
  it("joins the tab and the window with the shared separator", () => {
    expect(trendsContextLabel("Overview", "90D")).toBe(
      `Overview${TRENDS_CONTEXT_SEPARATOR}90D`
    );
    expect(trendsContextLabel("Body", "All time")).toBe("Body · All time");
  });

  it("always carries both halves — a chart is never shown unnamed", () => {
    const label = trendsContextLabel("Insights", "2026-01-01 → 2026-02-01");
    expect(label).toContain("Insights");
    expect(label).toContain("2026-01-01 → 2026-02-01");
  });
});
