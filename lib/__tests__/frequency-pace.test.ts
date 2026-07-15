import { describe, it, expect } from "vitest";
import { frequencyPace, frequencyPaceLabel } from "@/lib/goals";

// Pure-tier tests for the weekly-habit pacing state (issue #748 item 3). The bug: a
// target was only ever "met" or "Behind", so on the first day of the week EVERY unmet
// habit read amber "Behind". `frequencyPace` adds the "on-pace" middle state, and both
// surfaces that show it (the /nutrition Weekly-habits badge and the dashboard
// Goals-and-habits widget) key on this ONE computation — this file pins the input→state
// contract so the two can't drift.

describe("frequencyPace", () => {
  it("is 'met' once the full cadence is logged, regardless of how much week elapsed", () => {
    expect(frequencyPace(2, 2, 1)).toBe("met");
    expect(frequencyPace(3, 2, 7)).toBe("met");
  });

  it("does NOT read 'behind' on day 1 of a modest habit (the reported bug)", () => {
    // 2×/week on the first day: floor(2·1/7)=0 owed so far → on pace with 0 logged.
    expect(frequencyPace(0, 2, 1)).toBe("on-pace");
  });

  it("is 'behind' when the count trails the share of the week elapsed", () => {
    // Full week elapsed, nothing logged of a 2×/week habit.
    expect(frequencyPace(0, 2, 7)).toBe("behind");
    // Full week, 1 of 2 — still short.
    expect(frequencyPace(1, 2, 7)).toBe("behind");
    // A daily habit owes one on day 1.
    expect(frequencyPace(0, 7, 1)).toBe("behind");
  });

  it("is 'on-pace' when the count keeps up with the elapsed share", () => {
    // Mid-week (day 4) of 2×/week: floor(2·4/7)=1 owed → 1 logged is on pace.
    expect(frequencyPace(1, 2, 4)).toBe("on-pace");
    // Daily habit, day 3, 3 logged.
    expect(frequencyPace(3, 7, 3)).toBe("on-pace");
  });

  it("clamps elapsedDays into 1..7 and treats per_week ≤ 0 as met", () => {
    expect(frequencyPace(0, 2, 0)).toBe("on-pace"); // clamped to day 1
    expect(frequencyPace(1, 2, 99)).toBe("behind"); // clamped to day 7
    expect(frequencyPace(0, 0, 3)).toBe("met");
  });
});

describe("frequencyPaceLabel", () => {
  it("labels each paced state", () => {
    expect(frequencyPaceLabel("met")).toBe("On track");
    expect(frequencyPaceLabel("on-pace")).toBe("On pace");
    expect(frequencyPaceLabel("behind")).toBe("Behind");
  });
});
