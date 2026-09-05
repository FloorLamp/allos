import { describe, it, expect } from "vitest";
import {
  frequencyPace,
  frequencyPaceLabel,
  type FrequencyPace,
} from "@/lib/frequency-targets";

// Pure-tier tests for the weekly-habit pacing state — #748 item 3, re-ruled by #4758.
//
// #748 gave the state its "on-pace" middle so a fresh week could not read amber. #4758
// moved where that middle ENDS: a lag against the share of the week gone by is no longer
// enough to say "Behind", because it flagged a weekend trainer every Wednesday. The week
// must also have stopped fitting what is left of the target. Both surfaces that show the
// state (the /nutrition Weekly-habits badge and the dashboard goal/habit atoms) key on
// this ONE computation, so this file pins the input→state contract they share.
//
// `elapsedDays` counts today, so the days left INCLUDING today are 8 − elapsedDays.

describe("frequencyPace", () => {
  it.each<[number, number, number, FrequencyPace]>([
    // Met once the cadence is logged, whatever day it is — unchanged.
    [2, 2, 1, "met"],
    [3, 2, 7, "met"],
    [0, 0, 3, "met"], // nothing to pace

    // THE CASE #4758 IS NAMED FOR. A 2x/week target, nothing logged, on the Wednesday
    // of a Sunday-start week: four days left and two sessions to fit into them. There
    // is no finding here, so the row says "0 of 2 this week" and nothing else.
    [0, 2, 4, "on-pace"],
    [0, 2, 6, "on-pace"], // two days left, two to do — still fits
    [0, 2, 7, "behind"], // only today left, two to do — it cannot
    [1, 2, 7, "on-pace"], // one to do, and today to do it in

    // Reachable until the week is out, so a once-weekly target never reads Behind.
    [0, 1, 7, "on-pace"],

    // A daily target is the tightest fit there is: one missed day is unrecoverable.
    [0, 7, 1, "on-pace"],
    [0, 7, 2, "behind"],
    [3, 7, 4, "on-pace"],
    [3, 7, 5, "behind"],

    // Keeping up with the share of the week — untouched by the new boundary.
    [1, 2, 4, "on-pace"],
    [2, 5, 3, "on-pace"],

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
    const days = [1, 2, 3, 4, 5, 6, 7];
    // A rule that is only ever quiet is not a rule: the day it fires is pinned here
    // alongside the days it does not, so narrowing or widening either half reds.
    expect(days.filter((d) => frequencyPace(0, 2, d) === "behind")).toEqual([7]);
  });

  it("clamps elapsedDays into the 1..7 window", () => {
    // Observable on the upper clamp: day 99 unclamped leaves negative days left, which
    // would read "Behind" where day 7 reads on pace.
    expect(frequencyPace(1, 2, 99)).toBe(frequencyPace(1, 2, 7));
    expect(frequencyPace(1, 2, 99)).toBe("on-pace");
    // The lower clamp changes no verdict for a per_week ≤ 7 target (day 0 and day 1 both
    // leave room for the whole target), so this pins only that it stays on the scale.
    expect(frequencyPace(0, 2, 0)).toBe("on-pace");
  });
});

describe("frequencyPaceLabel", () => {
  it("labels each paced state", () => {
    expect(frequencyPaceLabel("met")).toBe("On track");
    expect(frequencyPaceLabel("on-pace")).toBe("On pace");
    expect(frequencyPaceLabel("behind")).toBe("Behind");
  });
});
