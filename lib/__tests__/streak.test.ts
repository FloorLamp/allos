import { describe, expect, it } from "vitest";
import { currentStreak } from "../streak";

// currentStreak is the ONLY streak computation left in the app (#1935/#1936/#1937/
// #1939). Its rest-tolerant siblings — flexibleStreak and the activityStreak that
// wrapped it — were deleted with the last user-facing streak they fed. What remains
// answers the coaching overtraining question ("you've trained N days in a row —
// take a rest day"), which is the app telling you to STOP, so its cliff is the
// point rather than a flaw.

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
