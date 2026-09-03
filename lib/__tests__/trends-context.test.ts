import { describe, expect, it } from "vitest";
import { activeRangeLabel } from "../trends-context";
import { defaultTrendsRange, quickRanges } from "../timeline-format";

// The Trends phone chrome's fixed range label: it names the window the charts
// are drawn over and never disagrees with the pill the expanded control lights.

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

  it("names a single day by its date, like any window no pill names", () => {
    expect(activeRangeLabel({ from: TODAY, to: TODAY }, TODAY)).toBe(TODAY);
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
