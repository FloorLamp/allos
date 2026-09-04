import { describe, expect, it } from "vitest";
import { recordedUsual, usual, USUAL_KINDS, type UsualKind } from "@/lib/usual";

// #5143 — the three legs, and the per-kind differences that had to survive the
// extraction. What is pinned here is the CONTRACT `practiceDurationPrefill`'s header
// wrote down and only it followed: recorded, else declared, else nothing.

const KIND: UsualKind = {
  recentCount: 3,
  windowDays: null,
  minSamples: 2,
  centre: "mean",
};

describe("the three legs", () => {
  it("takes the recorded centre when there is history", () => {
    expect(usual([10, 20, 30], 99, KIND)).toBe(20);
  });

  it("falls to the declared value when history is under the floor", () => {
    expect(usual([10], 99, KIND)).toBe(99);
  });

  it("answers nothing when there is neither", () => {
    expect(usual([10], null, KIND)).toBeNull();
    expect(usual([], null, KIND)).toBeNull();
  });

  it("treats a declared value at or below zero as absent, not as an answer", () => {
    // A zero duration or a zero rest is not a statement anybody means, and seeding one
    // would put an impossible value in front of a person (#2204 constraint 2).
    expect(usual([10], 0, KIND)).toBeNull();
    expect(usual([10], -5, KIND)).toBeNull();
    expect(usual([10], Number.NaN, KIND)).toBeNull();
  });

  it("reads only the recent window, newest first", () => {
    // The fourth sample is outside a three-deep window and cannot move the answer.
    expect(usual([10, 20, 30, 900], null, KIND)).toBe(20);
  });

  it("offers the recorded leg alone, for a surface that must not echo a stated value", () => {
    expect(recordedUsual([10], KIND)).toBeNull();
    expect(recordedUsual([10, 20, 30], KIND)).toBe(20);
  });
});

describe("the centre is per kind, which is the whole reason it is a field", () => {
  const samples = [10, 10, 40];

  it("gives three different honest answers for one sample set", () => {
    // Mean 20, median 10, mode 10 — and the six derivations really did use all three.
    // A unified centre would have silently moved four fixtures' answers, which is the
    // opposite of an extraction.
    const at = (centre: UsualKind["centre"]) =>
      recordedUsual(samples, {
        recentCount: null,
        windowDays: null,
        minSamples: 1,
        centre,
      });
    expect(at("mean")).toBe(20);
    expect(at("median")).toBe(10);
    expect(at("mode")).toBe(10);
  });

  it("breaks a mode tie with the NEWEST sample, because samples arrive newest first", () => {
    expect(
      recordedUsual([25, 25, 40, 40], {
        recentCount: null,
        windowDays: null,
        minSamples: 1,
        centre: "mode",
      })
    ).toBe(25);
  });
});

describe("the table states what shipped", () => {
  it("keeps each kind's window, floor and centre as they were", () => {
    // Every number here is what the six derivations spent before the table existed.
    // Changing one is a behaviour change and belongs to whichever issue wants it.
    expect(USUAL_KINDS.sleepClock).toEqual({
      recentCount: null,
      windowDays: 28,
      minSamples: 14,
      centre: "median",
    });
    expect(USUAL_KINDS.eventPhysiology).toEqual({
      recentCount: 10,
      windowDays: null,
      minSamples: 3,
      centre: "mean",
    });
    expect(USUAL_KINDS.practiceDuration).toEqual({
      recentCount: null,
      windowDays: null,
      minSamples: 1,
      centre: "mode",
    });
    expect(USUAL_KINDS.recapSleepNight).toEqual({
      recentCount: null,
      windowDays: null,
      minSamples: 3,
      centre: "median",
    });
    expect(USUAL_KINDS.recapWeeklyWorkouts).toEqual({
      recentCount: null,
      windowDays: null,
      minSamples: 1,
      centre: "median",
    });
    expect(USUAL_KINDS.illnessDuration).toEqual({
      recentCount: null,
      windowDays: null,
      minSamples: 1,
      centre: "median",
    });
  });

  it("names every kind the table holds, so a new one cannot arrive unstated", () => {
    // The assertions above are per-kind, so a kind added without a line of its own
    // would pass them all. This is the line that fails.
    expect(Object.keys(USUAL_KINDS).sort()).toEqual([
      "eventPhysiology",
      "illnessDuration",
      "practiceDuration",
      "recapSleepNight",
      "recapWeeklyWorkouts",
      "sleepClock",
    ]);
  });
});
