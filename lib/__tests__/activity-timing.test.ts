import { describe, it, expect } from "vitest";
import {
  activityTiming,
  isElapsedPlausible,
  resolveElapsedMin,
} from "@/lib/activity-timing";

// The canonical ACTIVE-vs-ELAPSED model (#1202). Active = duration_min; elapsed =
// stored elapsed_min else the end−start span; rest = elapsed − active when both are
// known and plausible (elapsed ≥ active). Mixed-source fixtures pin the invariant.
describe("activityTiming", () => {
  it("active is the stored duration_min", () => {
    expect(activityTiming({ durationMin: 45 }).activeMin).toBe(45);
    expect(activityTiming({ durationMin: null }).activeMin).toBeNull();
  });

  // Issue fixture: a single paused run — active 45 (moving), elapsed 60 (15 rest).
  it("single paused run: active 45, elapsed 60, rest 15", () => {
    const t = activityTiming({
      durationMin: 45,
      startTime: "07:00",
      endTime: "08:00",
    });
    expect(t).toEqual({ activeMin: 45, elapsedMin: 60, restMin: 15 });
  });

  // Issue fixture: a brick — active 90 (Σ legs), elapsed 98 (8-min transitions).
  it("brick: active 90, elapsed 98, rest 8", () => {
    const t = activityTiming({
      durationMin: 90,
      startTime: "06:00",
      endTime: "07:38",
    });
    expect(t).toEqual({ activeMin: 90, elapsedMin: 98, restMin: 8 });
  });

  it("prefers a stored elapsed_min over the clock span", () => {
    const t = activityTiming({
      durationMin: 45,
      elapsedMin: 62,
      startTime: "07:00",
      endTime: "08:00", // span 60, but the stored 62 wins
    });
    expect(t.elapsedMin).toBe(62);
    expect(t.restMin).toBe(17);
  });

  it("derives elapsed from the clock span when no elapsed_min is stored", () => {
    expect(
      activityTiming({ durationMin: 30, startTime: "09:00", endTime: "09:40" })
        .elapsedMin
    ).toBe(40);
  });

  it("no rest when active equals elapsed (a run with no pause)", () => {
    const t = activityTiming({
      durationMin: 60,
      startTime: "07:00",
      endTime: "08:00",
    });
    expect(t).toEqual({ activeMin: 60, elapsedMin: 60, restMin: 0 });
  });

  it("elapsed unknown when there is no clock and no stored elapsed", () => {
    const t = activityTiming({ durationMin: 45 });
    expect(t).toEqual({ activeMin: 45, elapsedMin: null, restMin: null });
  });

  // The elapsed ≥ active invariant (#132): a stored elapsed below active is a data
  // error — treated as unknown so a bad row never shows negative rest.
  it("rejects (treats as unknown) an elapsed below active", () => {
    const t = activityTiming({ durationMin: 60, elapsedMin: 45 });
    expect(t.elapsedMin).toBeNull();
    expect(t.restMin).toBeNull();
  });
});

describe("isElapsedPlausible", () => {
  it("elapsed must be ≥ active", () => {
    expect(isElapsedPlausible(45, 60)).toBe(true);
    expect(isElapsedPlausible(60, 60)).toBe(true);
    expect(isElapsedPlausible(60, 45)).toBe(false);
  });
  it("is vacuously true when either is unknown", () => {
    expect(isElapsedPlausible(null, 45)).toBe(true);
    expect(isElapsedPlausible(45, null)).toBe(true);
  });
});

describe("resolveElapsedMin", () => {
  it("stored elapsed_min wins, else the clock span, else null", () => {
    expect(resolveElapsedMin({ durationMin: 45, elapsedMin: 62 })).toBe(62);
    expect(
      resolveElapsedMin({
        durationMin: 45,
        startTime: "07:00",
        endTime: "08:00",
      })
    ).toBe(60);
    expect(resolveElapsedMin({ durationMin: 45 })).toBeNull();
  });
});
