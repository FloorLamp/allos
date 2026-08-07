import { describe, it, expect } from "vitest";
import { rangeContainsDate, type DateRange } from "@/lib/date-range";

// Pure-tier: the date-ranged container chassis (issue #943). The ONE range-membership
// computation both menstrual cycles (`period_end`) and illness episodes (`end_date`)
// format over. Since #2232 the chassis expresses exactly ONE end-bound convention —
// `end` is the INCLUSIVE last member day — so an exclusive end can no longer even be
// passed in; this test pins the inclusive boundary on both ends.

const range = (start: string | null, end: string | null): DateRange => ({
  start,
  end,
});

describe("rangeContainsDate — inclusive bounds", () => {
  const r = range("2026-01-01", "2026-01-05");

  it("covers the start day and the inclusive end day", () => {
    expect(rangeContainsDate(r, "2026-01-01")).toBe(true);
    expect(rangeContainsDate(r, "2026-01-05")).toBe(true);
  });

  it("covers an interior day", () => {
    expect(rangeContainsDate(r, "2026-01-03")).toBe(true);
  });

  it("excludes the day before the start and the day after the end", () => {
    expect(rangeContainsDate(r, "2025-12-31")).toBe(false);
    expect(rangeContainsDate(r, "2026-01-06")).toBe(false);
  });

  it("a one-day window (end == start) covers exactly that day", () => {
    const oneDay = range("2026-01-01", "2026-01-01");
    expect(rangeContainsDate(oneDay, "2026-01-01")).toBe(true);
    expect(rangeContainsDate(oneDay, "2025-12-31")).toBe(false);
    expect(rangeContainsDate(oneDay, "2026-01-02")).toBe(false);
  });

  it("an inverted window (end < start — a same-day flap's empty row) covers nothing", () => {
    const empty = range("2026-01-02", "2026-01-01");
    expect(rangeContainsDate(empty, "2026-01-01")).toBe(false);
    expect(rangeContainsDate(empty, "2026-01-02")).toBe(false);
  });
});

describe("rangeContainsDate — open and unbounded ends", () => {
  it("a null end is open/ongoing: covers everything from the start onward", () => {
    const open = range("2026-01-01", null);
    expect(rangeContainsDate(open, "2026-01-01")).toBe(true);
    expect(rangeContainsDate(open, "2030-06-01")).toBe(true);
    expect(rangeContainsDate(open, "2025-12-31")).toBe(false);
  });

  it("a null start is unbounded-past: covers everything up to the inclusive end", () => {
    const beforeLog = range(null, "2026-01-05");
    expect(rangeContainsDate(beforeLog, "0001-01-01")).toBe(true);
    expect(rangeContainsDate(beforeLog, "2026-01-05")).toBe(true);
    expect(rangeContainsDate(beforeLog, "2026-01-06")).toBe(false);
  });

  it("null start AND null end covers every date (an open before-log run)", () => {
    const unbounded = range(null, null);
    expect(rangeContainsDate(unbounded, "0001-01-01")).toBe(true);
    expect(rangeContainsDate(unbounded, "2099-12-31")).toBe(true);
  });
});
