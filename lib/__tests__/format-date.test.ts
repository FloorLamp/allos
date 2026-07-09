import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatLongDate,
  formatRelativeDate,
  formatRelativeTime,
  daysUntil,
  daysRemainingLabel,
} from "@/lib/format-date";

// formatLongDate reads the current year from the clock, so pin it. The relative
// helpers instead take an explicit `todayStr`, so they don't depend on fake time.
const TODAY = "2026-06-30"; // Tue Jun 30 2026
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe("formatLongDate", () => {
  it("omits the year for the current calendar year", () => {
    const s = formatLongDate("2026-06-30");
    expect(s).toContain("June");
    expect(s).toContain("30");
    expect(s).not.toContain("2026");
  });

  it("appends the year for other years", () => {
    expect(formatLongDate("2024-12-25")).toContain("2024");
  });

  it("parses the ISO date as local midnight (no day shift)", () => {
    // Should render the 30th, not the 29th, regardless of timezone.
    expect(formatLongDate("2026-06-30")).toContain("30");
  });

  it("returns the input unchanged when unparseable", () => {
    expect(formatLongDate("not-a-date")).toBe("not-a-date");
  });
});

describe("formatRelativeDate", () => {
  it("labels today and future dates as 'Today'", () => {
    expect(formatRelativeDate("2026-06-30", TODAY)).toBe("Today");
    expect(formatRelativeDate("2026-07-05", TODAY)).toBe("Today");
  });

  it("labels the previous day as 'Yesterday'", () => {
    expect(formatRelativeDate("2026-06-29", TODAY)).toBe("Yesterday");
  });

  it("labels recent days in days", () => {
    expect(formatRelativeDate("2026-06-27", TODAY)).toBe("3 days ago");
  });

  it("labels weeks, months, and years with correct pluralization", () => {
    expect(formatRelativeDate("2026-06-23", TODAY)).toBe("1 week ago");
    expect(formatRelativeDate("2026-06-16", TODAY)).toBe("2 weeks ago");
    expect(formatRelativeDate("2026-05-15", TODAY)).toBe("2 months ago");
    expect(formatRelativeDate("2025-06-30", TODAY)).toBe("1 year ago");
    expect(formatRelativeDate("2024-06-30", TODAY)).toBe("2 years ago");
  });

  it("uses the passed today, independent of the process clock/timezone", () => {
    // With an explicit today of Jul 2, Jun 30 is 2 days ago regardless of TZ.
    expect(formatRelativeDate("2026-06-30", "2026-07-02")).toBe("2 days ago");
  });

  it("returns the input unchanged when unparseable", () => {
    expect(formatRelativeDate("nonsense", TODAY)).toBe("nonsense");
  });
});

describe("formatRelativeTime", () => {
  // Fixed reference instant; timestamps below are SQLite UTC datetimes. Passing
  // `now` explicitly keeps this independent of the test runner's timezone.
  const now = new Date("2026-06-30T12:00:00Z");

  it("labels sub-minute gaps as 'just now'", () => {
    expect(formatRelativeTime("2026-06-30 11:59:30", now)).toBe("just now");
    expect(formatRelativeTime("2026-06-30 12:00:10", now)).toBe("just now"); // future skew
  });

  it("labels minutes and hours, singularizing one", () => {
    expect(formatRelativeTime("2026-06-30 11:58:00", now)).toBe(
      "2 minutes ago"
    );
    expect(formatRelativeTime("2026-06-30 11:59:00", now)).toBe("1 minute ago");
    expect(formatRelativeTime("2026-06-30 11:00:00", now)).toBe("1 hour ago");
    expect(formatRelativeTime("2026-06-30 09:00:00", now)).toBe("3 hours ago");
  });

  it("crosses into day granularity", () => {
    expect(formatRelativeTime("2026-06-29 12:00:00", now)).toBe("Yesterday");
    expect(formatRelativeTime("2026-06-27 12:00:00", now)).toBe("3 days ago");
    expect(formatRelativeTime("2026-06-23 12:00:00", now)).toBe("1 week ago");
  });

  it("parses the SQLite datetime as UTC, not local", () => {
    // Same wall-clock string with an explicit Z must match the UTC 'now'.
    expect(formatRelativeTime("2026-06-30T12:00:00Z", now)).toBe("just now");
  });

  it("returns the input unchanged when unparseable", () => {
    expect(formatRelativeTime("nonsense", now)).toBe("nonsense");
  });
});

describe("daysUntil", () => {
  it("returns 0 for today", () => {
    expect(daysUntil("2026-06-30", TODAY)).toBe(0);
  });

  it("returns a positive count for future dates", () => {
    expect(daysUntil("2026-07-10", TODAY)).toBe(10);
  });

  it("returns a negative count for past dates", () => {
    expect(daysUntil("2026-06-25", TODAY)).toBe(-5);
  });

  it("returns null when unparseable", () => {
    expect(daysUntil("bad", TODAY)).toBeNull();
  });
});

describe("daysRemainingLabel", () => {
  it("labels today and tomorrow specially", () => {
    expect(daysRemainingLabel("2026-06-30", TODAY)).toBe("today");
    expect(daysRemainingLabel("2026-07-01", TODAY)).toBe("tomorrow");
  });

  it("labels future dates as 'N days left'", () => {
    expect(daysRemainingLabel("2026-07-10", TODAY)).toBe("10 days left");
  });

  it("labels overdue dates, singularizing one day", () => {
    expect(daysRemainingLabel("2026-06-29", TODAY)).toBe("1 day overdue");
    expect(daysRemainingLabel("2026-06-27", TODAY)).toBe("3 days overdue");
  });

  it("returns null when unparseable", () => {
    expect(daysRemainingLabel("bad", TODAY)).toBeNull();
  });
});
