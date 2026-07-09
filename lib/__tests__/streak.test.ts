import { describe, expect, it } from "vitest";
import { currentStreak, flexibleStreak } from "../streak";

describe("currentStreak", () => {
  it("is 0 with no active dates", () => {
    expect(currentStreak("2024-03-10", [])).toBe(0);
  });

  it("counts consecutive days anchored on today", () => {
    const dates = ["2024-03-10", "2024-03-09", "2024-03-08"];
    expect(currentStreak("2024-03-10", dates)).toBe(3);
  });

  it("anchors on yesterday when today has no activity yet", () => {
    // Haven't trained today, but a streak ending yesterday still reads current.
    const dates = ["2024-03-09", "2024-03-08"];
    expect(currentStreak("2024-03-10", dates)).toBe(2);
  });

  it("is 0 when neither today nor yesterday is active", () => {
    const dates = ["2024-03-08", "2024-03-07"];
    expect(currentStreak("2024-03-10", dates)).toBe(0);
  });

  it("stops at the first gap", () => {
    // 10, 9 are consecutive; 7 is broken by the missing 8th.
    const dates = ["2024-03-10", "2024-03-09", "2024-03-07"];
    expect(currentStreak("2024-03-10", dates)).toBe(2);
  });

  it("ignores order and duplicates in the input dates", () => {
    const dates = ["2024-03-08", "2024-03-10", "2024-03-10", "2024-03-09"];
    expect(currentStreak("2024-03-10", dates)).toBe(3);
  });

  it("depends only on the anchor date string (timezone-boundary semantics)", () => {
    const dates = ["2024-03-10"];
    // The same underlying data reads differently depending on which calendar
    // date the profile's timezone considers "today":
    expect(currentStreak("2024-03-10", dates)).toBe(1); // today anchor
    expect(currentStreak("2024-03-11", dates)).toBe(1); // yesterday anchor
    expect(currentStreak("2024-03-12", dates)).toBe(0); // two days stale
  });

  it("handles a streak spanning a month boundary", () => {
    const dates = ["2024-03-01", "2024-02-29", "2024-02-28"];
    expect(currentStreak("2024-03-01", dates)).toBe(3);
  });
});

describe("flexibleStreak", () => {
  it("is 0 with no active dates", () => {
    expect(flexibleStreak("2024-03-10", [])).toBe(0);
  });

  it("counts consecutive active days like the strict streak", () => {
    const dates = ["2024-03-10", "2024-03-09", "2024-03-08"];
    expect(flexibleStreak("2024-03-10", dates)).toBe(3);
  });

  it("bridges a single rest day (the whole point vs currentStreak)", () => {
    // Trained every other day: strict streak dies immediately, flexible counts
    // every active day because each gap is a single tolerated rest day.
    const dates = ["2024-03-10", "2024-03-08", "2024-03-06", "2024-03-04"];
    expect(currentStreak("2024-03-10", dates)).toBe(1);
    expect(flexibleStreak("2024-03-10", dates)).toBe(4);
  });

  it("counts active days, not the calendar span (rest days don't inflate)", () => {
    const dates = ["2024-03-10", "2024-03-08"];
    expect(flexibleStreak("2024-03-10", dates)).toBe(2);
  });

  it("breaks when more than restDaysAllowed consecutive days are missed", () => {
    // Two-day gap (3-08 → 3-05) exceeds the default 1 rest-day tolerance.
    const dates = ["2024-03-10", "2024-03-08", "2024-03-05"];
    expect(flexibleStreak("2024-03-10", dates)).toBe(2);
  });

  it("at restDaysAllowed = 1 it matches currentStreak's currency anchoring", () => {
    // Today and yesterday both empty → not current under either rule.
    const stale = ["2024-03-08", "2024-03-07"];
    expect(flexibleStreak("2024-03-10", stale, 1)).toBe(0);
    expect(currentStreak("2024-03-10", stale)).toBe(0);
    // Anchors on yesterday when today is empty.
    const yesterday = ["2024-03-09", "2024-03-08"];
    expect(flexibleStreak("2024-03-10", yesterday, 1)).toBe(2);
  });

  it("honors a wider rest tolerance", () => {
    // Weekly training (6-day gaps) needs restDaysAllowed >= 6 to stay linked.
    const dates = ["2024-03-10", "2024-03-04", "2024-02-27"];
    expect(flexibleStreak("2024-03-10", dates, 1)).toBe(1);
    expect(flexibleStreak("2024-03-10", dates, 6)).toBe(3);
  });

  it("is always >= the strict streak", () => {
    const dates = ["2024-03-10", "2024-03-09", "2024-03-07", "2024-03-06"];
    expect(flexibleStreak("2024-03-10", dates)).toBeGreaterThanOrEqual(
      currentStreak("2024-03-10", dates)
    );
  });
});
