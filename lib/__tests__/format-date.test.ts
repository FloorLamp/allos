import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatLongDate,
  formatMonthDay,
  formatClock,
  formatClockMinutes,
  formatClockValue,
  formatDateShape,
  formatRelativeDate,
  formatRelativeTime,
  formatCompactRelativeTime,
  daysUntil,
  daysRemainingLabel,
  DEFAULT_FORMAT_PREFS,
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

  it("default prefs are byte-identical to the long-date shape", () => {
    // "mdy" long with weekday, year appended for a non-current year.
    expect(formatLongDate("2024-12-25")).toBe("Wednesday, December 25, 2024");
    expect(formatLongDate("2024-12-25", DEFAULT_FORMAT_PREFS)).toBe(
      "Wednesday, December 25, 2024"
    );
  });

  it("reorders the month/day for a dmy or iso login", () => {
    expect(
      formatLongDate("2024-12-25", { timeFormat: "24h", dateFormat: "dmy" })
    ).toBe("Wednesday, 25 December 2024");
    expect(
      formatLongDate("2024-12-25", { timeFormat: "24h", dateFormat: "iso" })
    ).toBe("Wednesday, 2024-12-25");
  });
});

describe("formatMonthDay", () => {
  it("default prefs render the compact 'Mon D' shape", () => {
    // Fake time is 2026, so a 2026 date omits the year.
    expect(formatMonthDay("2026-08-03")).toBe("Aug 3");
    expect(formatMonthDay("2024-08-03")).toBe("Aug 3, 2024");
  });

  it("reorders for a dmy / iso login", () => {
    expect(
      formatMonthDay("2024-08-03", { timeFormat: "24h", dateFormat: "dmy" })
    ).toBe("3 Aug 2024");
    expect(
      formatMonthDay("2024-08-03", { timeFormat: "24h", dateFormat: "iso" })
    ).toBe("2024-08-03");
  });
});

describe("formatClock", () => {
  it("renders a 24-hour clock zero-padded", () => {
    expect(formatClock("24h", 16, 2)).toBe("16:02");
    expect(formatClock("24h", 0, 0)).toBe("00:00");
    expect(formatClock("24h", 9, 5)).toBe("09:05");
  });

  it("renders a 12-hour clock with the midnight/noon edges", () => {
    expect(formatClock("12h", 0, 2)).toBe("12:02 AM");
    expect(formatClock("12h", 12, 0)).toBe("12:00 PM");
    expect(formatClock("12h", 13, 2)).toBe("1:02 PM");
    expect(formatClock("12h", 23, 59)).toBe("11:59 PM");
  });

  it("supports the compact lower-case meridiem style", () => {
    expect(formatClock("12h", 16, 2, "lower-nospace")).toBe("4:02pm");
    expect(formatClock("12h", 0, 0, "lower-nospace")).toBe("12:00am");
  });
});

describe("formatClockMinutes", () => {
  it("formats a minute-of-day through the clock pref (#1163)", () => {
    // 23:30 = 1410 minutes; 07:02 = 422 minutes.
    expect(formatClockMinutes("24h", 1410)).toBe("23:30");
    expect(formatClockMinutes("12h", 1410)).toBe("11:30 PM");
    expect(formatClockMinutes("24h", 422)).toBe("07:02");
    expect(formatClockMinutes("12h", 422)).toBe("7:02 AM");
  });

  it("wraps modulo the day so a noon-anchored hour maps cleanly", () => {
    // Midnight can arrive as 1440 (24.0h noon-anchored → 1440m) — folds to 00:00.
    expect(formatClockMinutes("24h", 1440)).toBe("00:00");
    expect(formatClockMinutes("12h", 1440)).toBe("12:00 AM");
    // And a negative wraps into range too.
    expect(formatClockMinutes("24h", -30)).toBe("23:30");
  });

  it("rounds a fractional minute (decimal-hour × 60) to the nearest minute", () => {
    // 22.5h noon-anchored → 1350m exactly → 22:30.
    expect(formatClockMinutes("24h", Math.round(22.5 * 60))).toBe("22:30");
  });
});

describe("formatClockValue", () => {
  it("routes stored clock text through the selected display format", () => {
    expect(formatClockValue("21:30", "24h")).toBe("21:30");
    expect(formatClockValue("21:30:00", "12h")).toBe("9:30 PM");
    expect(formatClockValue("4:02pm", "24h")).toBe("16:02");
  });

  it("preserves unknown text and honors the fallback", () => {
    expect(formatClockValue("unknown", "12h")).toBe("unknown");
    expect(formatClockValue(null, "24h", "—")).toBe("—");
  });
});

describe("formatDateShape", () => {
  it("shapes mdy/dmy/iso with short and long months", () => {
    expect(
      formatDateShape("mdy", 2026, 1, 5, { monthStyle: "short", year: true })
    ).toBe("Jan 5, 2026");
    expect(
      formatDateShape("mdy", 2026, 1, 5, { monthStyle: "long", year: true })
    ).toBe("January 5, 2026");
    expect(
      formatDateShape("dmy", 2026, 1, 5, { monthStyle: "short", year: true })
    ).toBe("5 Jan 2026");
    expect(formatDateShape("iso", 2026, 1, 5)).toBe("2026-01-05");
  });

  it("prefixes a weekday and omits the year on request", () => {
    expect(
      formatDateShape("mdy", 2026, 1, 5, {
        monthStyle: "long",
        weekday: "Monday",
        year: false,
      })
    ).toBe("Monday, January 5");
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

describe("formatCompactRelativeTime", () => {
  const now = new Date("2026-06-30T12:00:00Z");

  it("shortens minute and hour units without abbreviating longer dates", () => {
    expect(formatCompactRelativeTime("2026-06-30T11:58:00Z", now)).toBe(
      "2 mins ago"
    );
    expect(formatCompactRelativeTime("2026-06-30T10:00:00Z", now)).toBe(
      "2 hrs ago"
    );
    expect(formatCompactRelativeTime("2026-06-29T12:00:00Z", now)).toBe(
      "Yesterday"
    );
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
