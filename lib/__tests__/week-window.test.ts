import { describe, expect, it } from "vitest";
import { shiftDateStr } from "@/lib/date";
import { weekWindow, trailingWeeks } from "@/lib/week-window";
import { recapWindow, resolveRecapWindow } from "@/lib/weekly-recap";

// TODAY is a Wednesday, so a calendar week starting Monday is a partial,
// in-progress week (Mon–Wed) — the case #223 is about.
const TODAY = "2026-07-08"; // Wednesday
const MONDAY = 1;

describe("weekWindow", () => {
  it("rolling mode is a trailing 7 days ending on today, prior 7 as comparison", () => {
    expect(weekWindow(TODAY, "rolling")).toEqual({
      start: "2026-07-02", // today - 6
      end: "2026-07-08",
      prevStart: "2026-06-25", // today - 13
      prevEnd: "2026-07-01", // today - 7
    });
  });

  it("calendar mode spans the current week-start day through today (partial week)", () => {
    // Week starts Monday (2026-07-06); today is Wednesday, so the current window
    // is the 3-day Mon–Wed span, with the prior full Mon–Sun week as comparison.
    expect(weekWindow(TODAY, "calendar", MONDAY)).toEqual({
      start: "2026-07-06", // Monday of this week
      end: "2026-07-08",
      prevStart: "2026-06-29", // previous Monday
      prevEnd: "2026-07-05", // previous Sunday
    });
  });

  it("comparison window is the contiguous full 7 days immediately before the start", () => {
    for (const mode of ["rolling", "calendar"] as const) {
      const w = weekWindow(TODAY, mode, MONDAY);
      expect(w.prevEnd).toBe(shiftDateStr(w.start, -1)); // day before start
      expect(w.prevStart).toBe(shiftDateStr(w.prevEnd, -6)); // a full 7-day span
    }
  });
});

// The one-question-one-computation pin for "this week" (issue #223): the recap's
// window (resolveRecapWindow) and the routine counters' window start
// (weekWindowStart, which is weekWindow(...).start) must be derived from the SAME
// weekWindow computation, so a calendar-week profile's "3 workouts this week" recap
// and "2 of 3 cardio this week" routine widget count the same days.
describe("recap and routine counters share one 'this week' (issue #223)", () => {
  it("recap window start equals the routine counters' week start in calendar mode", () => {
    const routineStart = weekWindow(TODAY, "calendar", MONDAY).start; // weekWindowStart
    const recap = resolveRecapWindow(TODAY, 7, "calendar", MONDAY);
    expect(recap.start).toBe(routineStart);
    expect(recap.end).toBe(TODAY);
  });

  it("recap window start equals the routine counters' week start in rolling mode", () => {
    const routineStart = weekWindow(TODAY, "rolling").start;
    const recap = resolveRecapWindow(TODAY, 7, "rolling");
    expect(recap.start).toBe(routineStart);
  });

  it("rolling 7-day recap is byte-for-byte the legacy trailing window (backward compat)", () => {
    expect(resolveRecapWindow(TODAY, 7, "rolling")).toEqual(
      recapWindow(TODAY, 7)
    );
    // No mode supplied ⇒ rolling default ⇒ still the legacy window.
    expect(resolveRecapWindow(TODAY, 7)).toEqual(recapWindow(TODAY, 7));
  });

  it("week_mode does not apply to non-weekly periods (monthly recap stays trailing)", () => {
    // A 30-day (monthly, #20) window ignores week_mode: it's a trailing window
    // regardless of the calendar setting.
    expect(resolveRecapWindow(TODAY, 30, "calendar", MONDAY)).toEqual(
      recapWindow(TODAY, 30)
    );
  });
});

describe("trailingWeeks (issue #954)", () => {
  it("returns N weeks oldest-first, current week last and in-progress", () => {
    // Calendar week starting Sunday; TODAY (Wed 2026-07-08) is in the week of 07-05.
    const weeks = trailingWeeks(TODAY, "calendar", 0, 4);
    expect(weeks).toHaveLength(4);
    // Oldest first.
    expect(weeks[0].start < weeks[3].start).toBe(true);
    // Current week is last: [Sunday 07-05, today], in-progress.
    const last = weeks[3];
    expect(last.start).toBe("2026-07-05");
    expect(last.end).toBe(TODAY);
    expect(last.isCurrent).toBe(true);
    // Past weeks are full 7-day blocks, not in-progress.
    expect(weeks[2]).toMatchObject({
      start: "2026-06-28",
      end: "2026-07-04",
      isCurrent: false,
    });
    expect(weeks[0].start).toBe("2026-06-14");
  });

  it("rolling mode anchors each week to a trailing 7-day block", () => {
    const weeks = trailingWeeks(TODAY, "rolling", 0, 3);
    // Current rolling week = [today-6, today].
    expect(weeks[2]).toMatchObject({
      start: "2026-07-02",
      end: TODAY,
      isCurrent: true,
    });
    // Each earlier block is 7 days before.
    expect(weeks[1].start).toBe("2026-06-25");
    expect(weeks[0].start).toBe("2026-06-18");
  });
});
