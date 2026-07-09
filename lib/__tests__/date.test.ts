import { describe, expect, it } from "vitest";
import {
  dateStrInTz,
  zonedDateParts,
  zonedMinuteStr,
  shiftDateStr,
  lastNDates,
  weekdayInTz,
  hourInTz,
  weekdayOfDateStr,
  ageFromBirthdate,
  startOfWeekStr,
  weekdayOrder,
  isoDate,
  monthNames,
  monthGridCells,
  ageInMonthsFromBirthdate,
} from "@/lib/date";

// A single instant that lands on different calendar dates / weekdays / hours
// depending on the zone: 02:30 UTC on Sun 2026-06-28.
//   UTC            → Sun 2026-06-28 02:30
//   America/NY(-4) → Sat 2026-06-27 22:30
//   Asia/Tokyo(+9) → Sun 2026-06-28 11:30
//   Kiritimati(+14)→ Sun 2026-06-28 16:30
const INSTANT = new Date("2026-06-28T02:30:00Z");

describe("dateStrInTz", () => {
  it("formats YYYY-MM-DD in the given zone", () => {
    expect(dateStrInTz("UTC", INSTANT)).toBe("2026-06-28");
    expect(dateStrInTz("Asia/Tokyo", INSTANT)).toBe("2026-06-28");
    expect(dateStrInTz("Pacific/Kiritimati", INSTANT)).toBe("2026-06-28");
  });

  it("rolls the calendar date back for a zone still on the previous day", () => {
    // 02:30 UTC is 22:30 the prior day in New York.
    expect(dateStrInTz("America/New_York", INSTANT)).toBe("2026-06-27");
  });

  it("zero-pads month and day", () => {
    expect(dateStrInTz("UTC", new Date("2026-01-05T12:00:00Z"))).toBe(
      "2026-01-05"
    );
  });
});

// The instant→profile-day / instant→profile-minute conversions that attribute a
// Health Connect sample's absolute timestamp to metric_samples.date and the
// hr_minutes.ts bucket in the PROFILE's timezone at ingest (issue #94). The three
// scenarios that used to bucket to the wrong day on a multi-zone deploy: a profile
// AHEAD of a UTC server, a profile BEHIND it, and a sample landing right at local
// midnight so the calendar day flips relative to UTC.
describe("zonedDateParts / zonedMinuteStr — profile-tz attribution", () => {
  // 23:30Z on Jun 15: evening in the west, already the next morning in the east.
  const evening = new Date("2026-06-15T23:30:00Z");

  it("profile ahead of the server rolls forward to the next local day", () => {
    // Asia/Tokyo is UTC+9 → 08:30 on the 16th.
    expect(zonedDateParts("Asia/Tokyo", evening)).toEqual({
      date: "2026-06-16",
      hhmm: "08:30",
    });
    expect(zonedMinuteStr("Asia/Tokyo", evening)).toBe("2026-06-16T08:30");
  });

  it("profile behind the server keeps the earlier local day", () => {
    // America/New_York is UTC-4 in June → still 19:30 on the 15th.
    expect(zonedDateParts("America/New_York", evening)).toEqual({
      date: "2026-06-15",
      hhmm: "19:30",
    });
    expect(zonedMinuteStr("America/New_York", evening)).toBe(
      "2026-06-15T19:30"
    );
  });

  it("attributes a sample crossing local midnight to the day each zone is on", () => {
    // 03:59Z on Jun 16 straddles midnight across zones from the same instant:
    //   New York (-4) → 23:59 on the 15th (previous local day)
    //   UTC          → 03:59 on the 16th
    //   Tokyo  (+9)  → 12:59 on the 16th
    const nearMidnight = new Date("2026-06-16T03:59:00Z");
    expect(zonedMinuteStr("America/New_York", nearMidnight)).toBe(
      "2026-06-15T23:59"
    );
    expect(zonedMinuteStr("UTC", nearMidnight)).toBe("2026-06-16T03:59");
    expect(zonedMinuteStr("Asia/Tokyo", nearMidnight)).toBe("2026-06-16T12:59");

    // Exactly local midnight folds to 00:00 (not "24:00") and belongs to the new day.
    const localMidnight = new Date("2026-06-16T04:00:00Z"); // 00:00 in New York
    expect(zonedDateParts("America/New_York", localMidnight)).toEqual({
      date: "2026-06-16",
      hhmm: "00:00",
    });
    expect(zonedMinuteStr("America/New_York", localMidnight)).toBe(
      "2026-06-16T00:00"
    );
  });
});

describe("shiftDateStr", () => {
  it("shifts by whole calendar days in both directions", () => {
    expect(shiftDateStr("2026-06-28", 0)).toBe("2026-06-28");
    expect(shiftDateStr("2026-06-28", -1)).toBe("2026-06-27");
    expect(shiftDateStr("2026-06-28", -6)).toBe("2026-06-22"); // inclusive 7-day window
    expect(shiftDateStr("2026-06-28", 3)).toBe("2026-07-01");
  });

  it("handles month and year rollover", () => {
    expect(shiftDateStr("2026-07-01", -1)).toBe("2026-06-30");
    expect(shiftDateStr("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateStr("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("handles leap days", () => {
    expect(shiftDateStr("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDateStr("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDateStr("2026-02-28", 1)).toBe("2026-03-01"); // non-leap year
  });

  it("is DST-immune (UTC-anchored): a US spring-forward boundary still shifts exactly one day", () => {
    // US DST began 2026-03-08; pure calendar math must not lose/gain a day.
    expect(shiftDateStr("2026-03-09", -1)).toBe("2026-03-08");
    expect(shiftDateStr("2026-03-08", -1)).toBe("2026-03-07");
  });
});

describe("lastNDates", () => {
  it("returns the n dates ending at (and including) the anchor, oldest first", () => {
    expect(lastNDates("2026-06-28", 3)).toEqual([
      "2026-06-26",
      "2026-06-27",
      "2026-06-28",
    ]);
  });

  it("returns just the anchor for n=1 and crosses month boundaries", () => {
    expect(lastNDates("2026-07-01", 1)).toEqual(["2026-07-01"]);
    expect(lastNDates("2026-07-01", 2)).toEqual(["2026-06-30", "2026-07-01"]);
  });
});

describe("weekdayInTz", () => {
  it("returns 0=Sun … 6=Sat in the given zone", () => {
    expect(weekdayInTz("UTC", INSTANT)).toBe(0); // Sunday
    expect(weekdayInTz("Asia/Tokyo", INSTANT)).toBe(0); // Sunday
  });

  it("returns the prior weekday for a zone still on the previous day", () => {
    expect(weekdayInTz("America/New_York", INSTANT)).toBe(6); // Saturday
  });
});

describe("hourInTz", () => {
  it("returns the 0–23 hour in the given zone", () => {
    expect(hourInTz("UTC", INSTANT)).toBe(2);
    expect(hourInTz("Asia/Tokyo", INSTANT)).toBe(11);
    expect(hourInTz("America/New_York", INSTANT)).toBe(22);
  });

  it("reports midnight as 0, not 24", () => {
    expect(hourInTz("UTC", new Date("2026-06-28T00:00:00Z"))).toBe(0);
    // Tokyo midnight = 15:00 UTC the previous day.
    expect(hourInTz("Asia/Tokyo", new Date("2026-06-27T15:00:00Z"))).toBe(0);
  });
});

describe("weekdayOfDateStr", () => {
  it("maps a stored YYYY-MM-DD to its weekday (TZ-independent)", () => {
    expect(weekdayOfDateStr("2026-06-28")).toBe(0); // Sunday
    expect(weekdayOfDateStr("2026-06-29")).toBe(1); // Monday
    expect(weekdayOfDateStr("2026-07-04")).toBe(6); // Saturday
    expect(weekdayOfDateStr("2024-02-29")).toBe(4); // leap day, Thursday
  });
});

describe("startOfWeekStr", () => {
  // 2026-06-28 is a Sunday; 2026-06-29 Monday … 2026-07-04 Saturday.
  it("defaults to a Sunday-start week", () => {
    expect(startOfWeekStr("2026-06-28")).toBe("2026-06-28"); // Sun → itself
    expect(startOfWeekStr("2026-06-29")).toBe("2026-06-28"); // Mon → prior Sun
    expect(startOfWeekStr("2026-07-04")).toBe("2026-06-28"); // Sat → prior Sun
  });

  it("anchors to a Monday-start week (weekStart=1)", () => {
    expect(startOfWeekStr("2026-06-29", 1)).toBe("2026-06-29"); // Mon → itself
    expect(startOfWeekStr("2026-06-28", 1)).toBe("2026-06-22"); // Sun → prior Mon
    expect(startOfWeekStr("2026-07-04", 1)).toBe("2026-06-29"); // Sat → that Mon
  });

  it("anchors to any weekday (Saturday-start, weekStart=6)", () => {
    expect(startOfWeekStr("2026-07-04", 6)).toBe("2026-07-04"); // Sat → itself
    expect(startOfWeekStr("2026-07-05", 6)).toBe("2026-07-04"); // Sun → prior Sat
    expect(startOfWeekStr("2026-07-03", 6)).toBe("2026-06-27"); // Fri → prior Sat
  });

  it("crosses month/year boundaries and is DST-immune", () => {
    expect(startOfWeekStr("2026-01-01", 1)).toBe("2025-12-29"); // Thu → prior Mon
    // US DST began 2026-03-08 (a Sunday); pure calendar math is unaffected.
    expect(startOfWeekStr("2026-03-10", 0)).toBe("2026-03-08");
  });
});

describe("weekdayOrder", () => {
  it("orders weekday indices from the configured start day", () => {
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6]); // Sunday-first
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]); // Monday-first
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5]); // Saturday-first
  });
});

describe("ageFromBirthdate", () => {
  it("counts whole years, subtracting one before the birthday lands", () => {
    // Born 1990-06-15, evaluated across the 2026 birthday.
    expect(ageFromBirthdate("1990-06-15", "2026-06-14")).toBe(35);
    expect(ageFromBirthdate("1990-06-15", "2026-06-15")).toBe(36);
    expect(ageFromBirthdate("1990-06-15", "2026-06-16")).toBe(36);
    expect(ageFromBirthdate("1990-06-15", "2027-01-01")).toBe(36);
  });

  it("handles a leap-day birthdate on non-leap reference years", () => {
    expect(ageFromBirthdate("2000-02-29", "2026-02-28")).toBe(25);
    expect(ageFromBirthdate("2000-02-29", "2026-03-01")).toBe(26);
  });

  it("returns null for a future or same-day-of-birth-in-future date", () => {
    expect(ageFromBirthdate("2030-01-01", "2026-06-15")).toBeNull();
  });

  it("returns 0 for an infant under a year old", () => {
    expect(ageFromBirthdate("2026-01-01", "2026-06-15")).toBe(0);
  });

  it("returns null for malformed inputs", () => {
    expect(ageFromBirthdate("1990", "2026-06-15")).toBeNull();
    expect(ageFromBirthdate("1990-06-15", "not-a-date")).toBeNull();
    expect(ageFromBirthdate("", "")).toBeNull();
  });
});

describe("isoDate", () => {
  it("assembles YYYY-MM-DD from 0-based month parts, zero-padded", () => {
    expect(isoDate(2026, 0, 1)).toBe("2026-01-01");
    expect(isoDate(2026, 6, 5)).toBe("2026-07-05");
    expect(isoDate(2026, 11, 31)).toBe("2026-12-31");
  });
});

describe("monthNames", () => {
  it("returns 12 non-empty names, short no longer than long", () => {
    const long = monthNames("long");
    const short = monthNames("short");
    expect(long).toHaveLength(12);
    expect(short).toHaveLength(12);
    expect(long.every((n) => n.length > 0)).toBe(true);
    // Short labels are an abbreviation of the long ones (locale-independent).
    expect(short.every((n, i) => n.length <= long[i].length)).toBe(true);
  });
});

describe("monthGridCells", () => {
  it("always fills complete weeks (length a multiple of 7)", () => {
    for (let m = 0; m < 12; m++) {
      for (let ws = 0; ws < 7; ws++) {
        expect(monthGridCells(2026, m, ws).length % 7).toBe(0);
      }
    }
  });

  it("includes every day of the month exactly once as an inside cell", () => {
    const inside = monthGridCells(2026, 6, 0).filter((c) => !c.outside); // July
    expect(inside.map((c) => c.d)).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1)
    );
    expect(inside.every((c) => c.y === 2026 && c.m === 6)).toBe(true);
  });

  it("pads the leading week with the previous month (Sunday start)", () => {
    // July 1 2026 is a Wednesday; Sunday-start → 3 leading days from June.
    const cells = monthGridCells(2026, 6, 0);
    expect(cells.slice(0, 3)).toEqual([
      { y: 2026, m: 5, d: 28, outside: true },
      { y: 2026, m: 5, d: 29, outside: true },
      { y: 2026, m: 5, d: 30, outside: true },
    ]);
    expect(cells[3]).toEqual({ y: 2026, m: 6, d: 1, outside: false });
    // 3 + 31 = 34 → one trailing day (Aug 1) completes the last week.
    expect(cells.at(-1)).toEqual({ y: 2026, m: 7, d: 1, outside: true });
  });

  it("shifts the leading pad for a Monday-start week", () => {
    const cells = monthGridCells(2026, 6, 1); // July, Monday-first
    expect(cells.slice(0, 2)).toEqual([
      { y: 2026, m: 5, d: 29, outside: true },
      { y: 2026, m: 5, d: 30, outside: true },
    ]);
  });

  it("has no leading pad when the 1st falls on the week-start day", () => {
    // July 1 2026 is a Wednesday (weekday 3).
    const cells = monthGridCells(2026, 6, 3);
    expect(cells[0]).toEqual({ y: 2026, m: 6, d: 1, outside: false });
  });

  it("rolls the pad across a year boundary", () => {
    // Jan 1 2026 is a Thursday; Sunday-start → 4 leading days from Dec 2025.
    const cells = monthGridCells(2026, 0, 0);
    expect(cells[0]).toEqual({ y: 2025, m: 11, d: 28, outside: true });
    // 4 + 31 = 35 → exact weeks, so the last cell is Jan 31, not a next-month pad.
    expect(cells.at(-1)).toEqual({ y: 2026, m: 0, d: 31, outside: false });
  });
});

describe("ageInMonthsFromBirthdate", () => {
  it("counts whole months, honoring day-of-month", () => {
    expect(ageInMonthsFromBirthdate("2026-01-01", "2026-03-01")).toBe(2);
    expect(ageInMonthsFromBirthdate("2026-01-15", "2026-03-14")).toBe(1); // not yet the 15th
    expect(ageInMonthsFromBirthdate("2026-01-15", "2026-03-15")).toBe(2);
  });

  it("handles year boundaries and multi-year ages", () => {
    expect(ageInMonthsFromBirthdate("2020-06-01", "2026-06-01")).toBe(72);
    expect(ageInMonthsFromBirthdate("2025-11-01", "2026-02-01")).toBe(3);
  });

  it("returns 0 at/near birth and null for malformed or future dates", () => {
    expect(ageInMonthsFromBirthdate("2026-06-01", "2026-06-10")).toBe(0);
    expect(ageInMonthsFromBirthdate("2026-06-01", "2026-05-01")).toBeNull();
    expect(ageInMonthsFromBirthdate("1990", "2026-06-15")).toBeNull();
  });
});
