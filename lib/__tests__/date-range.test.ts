import { describe, it, expect } from "vitest";
import {
  rangeContainsDate,
  INCLUSIVE_END,
  EXCLUSIVE_END,
  type DateRange,
} from "@/lib/date-range";

// Pure-tier: the date-ranged container chassis (issue #943). The ONE range-membership
// computation both menstrual cycles (inclusive end) and illness episodes (exclusive end)
// format over. The end-bound difference is the load-bearing thing this test pins — the
// chassis expresses BOTH, and cycles' inclusive `period_end` must never be silently read
// as illness episodes' exclusive `ended_at` (or vice versa).

const range = (start: string | null, end: string | null): DateRange => ({
  start,
  end,
});

describe("rangeContainsDate — inclusive end (menstrual cycles, period_end)", () => {
  const r = range("2026-01-01", "2026-01-05");

  it("covers the start and the inclusive end day", () => {
    expect(rangeContainsDate(r, "2026-01-01", INCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(r, "2026-01-05", INCLUSIVE_END)).toBe(true);
  });

  it("excludes the day before the start and the day after the end", () => {
    expect(rangeContainsDate(r, "2025-12-31", INCLUSIVE_END)).toBe(false);
    expect(rangeContainsDate(r, "2026-01-06", INCLUSIVE_END)).toBe(false);
  });
});

describe("rangeContainsDate — exclusive end (illness episodes, ended_at)", () => {
  const r = range("2026-01-01", "2026-01-05");

  it("covers the start but NOT the exclusive end day (last member is end minus one)", () => {
    expect(rangeContainsDate(r, "2026-01-01", EXCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(r, "2026-01-04", EXCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(r, "2026-01-05", EXCLUSIVE_END)).toBe(false);
  });

  it("is the crux difference: the same end date is a member iff inclusive", () => {
    expect(rangeContainsDate(r, "2026-01-05", INCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(r, "2026-01-05", EXCLUSIVE_END)).toBe(false);
  });
});

describe("rangeContainsDate — open and unbounded ends", () => {
  it("a null end is open/ongoing: covers everything from the start onward (either bound)", () => {
    const open = range("2026-01-01", null);
    expect(rangeContainsDate(open, "2026-01-01", INCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(open, "2030-06-01", INCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(open, "2030-06-01", EXCLUSIVE_END)).toBe(true);
    expect(rangeContainsDate(open, "2025-12-31", INCLUSIVE_END)).toBe(false);
  });

  it("a null start is unbounded-past: covers everything up to the end", () => {
    const beforeLog = range(null, "2026-01-05");
    expect(rangeContainsDate(beforeLog, "0001-01-01", EXCLUSIVE_END)).toBe(
      true
    );
    expect(rangeContainsDate(beforeLog, "2026-01-04", EXCLUSIVE_END)).toBe(
      true
    );
    expect(rangeContainsDate(beforeLog, "2026-01-05", EXCLUSIVE_END)).toBe(
      false
    );
    expect(rangeContainsDate(beforeLog, "2026-01-05", INCLUSIVE_END)).toBe(
      true
    );
  });

  it("null start AND null end covers every date (an open before-log run)", () => {
    const unbounded = range(null, null);
    expect(rangeContainsDate(unbounded, "0001-01-01", EXCLUSIVE_END)).toBe(
      true
    );
    expect(rangeContainsDate(unbounded, "2099-12-31", EXCLUSIVE_END)).toBe(
      true
    );
  });
});
