import { describe, it, expect } from "vitest";
import {
  frequencyPace,
  frequencyPaceLabel,
  type FrequencyPace,
} from "@/lib/frequency-targets";

// Pure-tier tests for the weekly-habit pacing state — #748 item 3, re-ruled by #4758,
// given its quiet state by #5395.
//
// #748 gave the state its "on-pace" middle so a fresh week could not read amber. #4758
// moved where "Behind" BEGINS: a lag against the share of the week gone by is no longer
// enough, because it flagged a weekend trainer every Wednesday; the week must also have
// stopped fitting what is left. #5395 moved where "On pace" begins: it is an affirmative
// finding, so it needs something logged that keeps up with the share. Between the two is
// "quiet" — a count and no verdict. Every surface that shows the state (the /nutrition
// Weekly-habits badge, the practice cards, the dashboard goal/habit atoms) keys on this
// ONE computation, so this file pins the input→state contract they share.
//
// `elapsedDays` counts today, so the days left INCLUDING today are 8 − elapsedDays.

describe("frequencyPace", () => {
  it.each<[number, number, number, FrequencyPace]>([
    // Met once the cadence is logged, whatever day it is — unchanged.
    [2, 2, 1, "met"],
    [3, 2, 7, "met"],
    [0, 0, 3, "met"], // nothing to pace

    // THE CASE #4758 IS NAMED FOR, AND #5395 AFTER IT. A 2x/week target, nothing logged,
    // on the Wednesday of a Sunday-start week: four days left and two sessions to fit
    // into them. There is no finding here, so the row says "0 of 2 this week" and
    // nothing else — not the "On pace" that #4758 left printed over it.
    [0, 2, 4, "quiet"],
    [0, 2, 6, "quiet"], // two days left, two to do — still fits
    [0, 2, 7, "behind"], // only today left, two to do — it cannot
    [1, 2, 7, "quiet"], // one to do, and today to do it in: lagging, but it fits

    // Reachable until the week is out, so a once-weekly target never reads Behind.
    [0, 1, 7, "quiet"],

    // A daily target is the tightest fit there is: one missed day is unrecoverable.
    [0, 7, 1, "quiet"],
    [0, 7, 2, "behind"],
    [3, 7, 4, "quiet"],
    [3, 7, 5, "behind"],

    // ON PACE IS AN AFFIRMATIVE FINDING (#5395): something logged, keeping up with the
    // share of the week gone by. Nothing logged is quiet even on day 1, before the share
    // owes anything, because there is no evidence to be on pace WITH.
    [1, 2, 4, "on-pace"],
    [2, 5, 3, "on-pace"],
    [1, 2, 1, "on-pace"], // logged on day 1: on pace from the first session
    [0, 2, 1, "quiet"], // nothing logged on day 1: no share owed, still no verdict

    // PER-KIND COUNTING SURVIVES. A 14-servings-a-week food group is logged several
    // times a day, so "days left" is the wrong unit for it. Two servings a day is on
    // pace on Wednesday; the days-left test alone would call it behind (8 to go, 4 days),
    // and the share test is what keeps this row quiet.
    [8, 14, 4, "on-pace"],
    [6, 14, 4, "behind"], // genuinely short: behind the share AND past fitting
  ])(
    "%i of %i on day %i reads %s",
    (count, perWeek, elapsedDays, expected: FrequencyPace) => {
      expect(frequencyPace(count, perWeek, elapsedDays)).toBe(expected);
    }
  );

  it("is quiet for six days of an untouched 2x/week week, and Behind on the seventh", () => {
    // A rule that is only ever quiet is not a rule: the day it fires is pinned here
    // alongside the days it does not, so narrowing or widening either half reds — and
    // so does an "On pace" creeping back onto a day nothing was logged.
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => frequencyPace(0, 2, d))).toEqual([
      ...Array<FrequencyPace>(6).fill("quiet"),
      "behind",
    ]);
  });

  it("clamps elapsedDays into the 1..7 window", () => {
    // Observable on the upper clamp: day 99 unclamped leaves negative days left, which
    // would read "Behind" where day 7 still fits the one session owed.
    expect(frequencyPace(1, 2, 99)).toBe(frequencyPace(1, 2, 7));
    expect(frequencyPace(1, 2, 99)).toBe("quiet");
    // The lower clamp changes no verdict for a per_week ≤ 7 target (day 0 and day 1 both
    // leave room for the whole target), so this pins only that it stays on the scale.
    expect(frequencyPace(0, 2, 0)).toBe("quiet");
  });
});

describe("frequencyPaceLabel", () => {
  it("labels each verdict", () => {
    expect(frequencyPaceLabel("met")).toBe("On track");
    expect(frequencyPaceLabel("on-pace")).toBe("On pace");
    expect(frequencyPaceLabel("behind")).toBe("Behind");
  });

  it("refuses a label for a quiet week at the type level", () => {
    // @ts-expect-error — a quiet week prints its count and no badge (#5395); the
    // parameter type is what stops a surface printing one, so this is the assertion.
    const wide: (pace: FrequencyPace) => string = frequencyPaceLabel;
    expect(wide).toBe(frequencyPaceLabel);
  });
});
