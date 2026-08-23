import { describe, it, expect } from "vitest";
import {
  dateToEpoch,
  epochToISO,
  timeAxisDomain,
  spansYearBoundary,
  timeAxisTicks,
  formatTimeTick,
} from "../chart-time-axis";

const DAY = 86_400_000;

describe("dateToEpoch / epochToISO", () => {
  it("maps a date to UTC-midnight epoch and back", () => {
    const e = dateToEpoch("2021-06-15");
    expect(e).toBe(Date.parse("2021-06-15T00:00:00Z"));
    expect(epochToISO(e)).toBe("2021-06-15");
  });
  it("is NaN for an unparseable date", () => {
    expect(Number.isNaN(dateToEpoch("not-a-date"))).toBe(true);
  });
});

describe("timeAxisDomain", () => {
  it("spans the min and max dates (position ∝ time, not index)", () => {
    // The regression case: two clustered points then a 4-year gap. The domain must
    // reach 2025, so the last point sits far to the right — not one step over.
    const d = timeAxisDomain(["2021-01-01", "2021-02-01", "2025-06-01"]);
    expect(d).not.toBeNull();
    expect(d![0]).toBe(dateToEpoch("2021-01-01"));
    expect(d![1]).toBe(dateToEpoch("2025-06-01"));
    // The gap dominates the span (far more than the 1-month cluster).
    expect(d![1] - d![0]).toBeGreaterThan(1000 * DAY);
  });
  it("opens a ±1 day window for a single point", () => {
    const d = timeAxisDomain(["2021-01-01"]);
    expect(d).toEqual([
      dateToEpoch("2021-01-01") - DAY,
      dateToEpoch("2021-01-01") + DAY,
    ]);
  });
  it("is null for an empty series", () => {
    expect(timeAxisDomain([])).toBeNull();
  });
});

describe("spansYearBoundary", () => {
  it("is false within one calendar year", () => {
    expect(
      spansYearBoundary(timeAxisDomain(["2021-01-05", "2021-11-30"]))
    ).toBe(false);
  });
  it("is true across a year boundary even for a short span", () => {
    expect(
      spansYearBoundary(timeAxisDomain(["2020-12-20", "2021-01-24"]))
    ).toBe(true);
  });
  it("is false for a null domain", () => {
    expect(spansYearBoundary(null)).toBe(false);
  });
});

describe("timeAxisTicks", () => {
  it("returns evenly-spaced inclusive ticks", () => {
    const d = timeAxisDomain(["2021-01-01", "2021-01-11"]); // 10 days
    const ticks = timeAxisTicks(d, 6);
    expect(ticks.length).toBe(6);
    expect(ticks[0]).toBe(d![0]);
    expect(ticks[ticks.length - 1]).toBe(d![1]);
    // Evenly spaced.
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    for (const g of gaps) expect(Math.abs(g - gaps[0])).toBeLessThanOrEqual(1);
  });
  it("returns a single endpoint for a degenerate domain", () => {
    expect(timeAxisTicks([5, 5])).toEqual([5]);
  });
  it("is empty for a null domain", () => {
    expect(timeAxisTicks(null)).toEqual([]);
  });
});

describe("formatTimeTick", () => {
  it("shows MM-DD within a year", () => {
    expect(formatTimeTick(dateToEpoch("2021-06-15"), false)).toBe("06-15");
  });
  it("shows YYYY-MM across years", () => {
    expect(formatTimeTick(dateToEpoch("2021-06-15"), true)).toBe("2021-06");
  });
});

describe("an axis never prints the same label twice (#3497 item 1)", () => {
  // The rendering the phone review met, on an ApoB-class analyte: a two-day span
  // subdivided into six evenly-spaced positions, which is three distinct days and
  // six ticks — "07-09 · 07-09 · 07-09 · 07-10 · 07-10 · 07-11".
  const twoDays = timeAxisDomain(["2026-07-09", "2026-07-11"])!;

  it("a sub-week span emits one tick per day it can name", () => {
    const ticks = timeAxisTicks(twoDays);
    const labels = ticks.map((t) => formatTimeTick(t, false));
    expect(labels).toEqual(["07-09", "07-10", "07-11"]);
  });

  it("the surviving ticks are the ORIGINAL positions, not re-spaced ones", () => {
    // The dedupe drops duplicates; it must not redistribute what is left, or the
    // ticks stop being time-proportional and the numeric axis loses its reason to
    // exist (#402).
    const [min, max] = twoDays;
    const evenly = [0, 1, 2, 3, 4, 5].map((i) =>
      Math.round(min + ((max - min) * i) / 5)
    );
    for (const t of timeAxisTicks(twoDays)) expect(evenly).toContain(t);
  });

  it("the endpoints are still the first and last labels", () => {
    const ticks = timeAxisTicks(twoDays);
    expect(ticks[0]).toBe(twoDays[0]);
    expect(formatTimeTick(ticks[ticks.length - 1], false)).toBe("07-11");
  });

  it("a span with room for every tick is untouched", () => {
    // The guard has to stay QUIET on the ordinary case, or it would be silently
    // thinning axes that were fine.
    const wide = timeAxisDomain(["2026-01-01", "2026-06-30"])!;
    expect(timeAxisTicks(wide)).toHaveLength(6);
  });

  it("a multi-year domain dedupes on the MONTH label it actually prints", () => {
    // Across years the label is "YYYY-MM", so the collision to avoid is two ticks
    // inside one month — a different vocabulary, and the reason the dedupe asks
    // the formatter rather than comparing days.
    const twoMonths = timeAxisDomain(["2025-12-20", "2026-01-10"])!;
    const labels = timeAxisTicks(twoMonths).map((t) => formatTimeTick(t, true));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["2025-12", "2026-01"]);
  });

  it("no domain this module can build produces a repeated label", () => {
    // Stated as the rule rather than as cases: every span from one day to five
    // years, at both tick vocabularies.
    for (const days of [1, 2, 3, 4, 5, 6, 7, 13, 29, 31, 90, 365, 1825]) {
      const start = new Date(Date.UTC(2024, 0, 1) + days * 86_400_000);
      const domain = timeAxisDomain([
        "2024-01-01",
        start.toISOString().slice(0, 10),
      ])!;
      const withYear = spansYearBoundary(domain);
      const labels = timeAxisTicks(domain).map((t) =>
        formatTimeTick(t, withYear)
      );
      expect(new Set(labels).size, `${days}d span`).toBe(labels.length);
    }
  });
});
