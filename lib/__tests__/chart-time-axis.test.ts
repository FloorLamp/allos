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
