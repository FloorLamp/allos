import { describe, it, expect } from "vitest";
import {
  projectGoal,
  describeEta,
  MIN_PROJECTION_POINTS,
  type ProjectionPoint,
} from "../trend-projection";

// A steady -1/week weight-loss trend: 90 → 87 over three weeks, last point on
// 2026-01-22. At this pace the extrapolation reaches 85 kg 14 days later
// (2026-02-05).
const LOSS: ProjectionPoint[] = [
  { date: "2026-01-01", value: 90 },
  { date: "2026-01-08", value: 89 },
  { date: "2026-01-15", value: 88 },
  { date: "2026-01-22", value: 87 },
];

describe("projectGoal", () => {
  it("projects the reach date at the fitted pace", () => {
    const p = projectGoal(LOSS, 85, null);
    expect(p?.status).toBe("reaching");
    expect(p?.projectedDate).toBe("2026-02-05");
    expect(p?.daysEarly).toBeNull(); // no target_date to compare
    expect(p?.slopePerDay).toBeCloseTo(-1 / 7, 6);
  });

  it("reaching EARLY: projected date beats a later target_date", () => {
    const p = projectGoal(LOSS, 85, "2026-02-26");
    expect(p?.status).toBe("reaching");
    // 2026-02-26 − 2026-02-05 = 21 days early.
    expect(p?.daysEarly).toBe(21);
    expect(describeEta(p!.daysEarly!)).toBe("~3 weeks early");
  });

  it("reaching LATE: projected date misses an earlier target_date", () => {
    const p = projectGoal(LOSS, 85, "2026-01-29");
    expect(p?.status).toBe("reaching");
    // 2026-01-29 − 2026-02-05 = −7 days late (under two weeks → shown in days).
    expect(p?.daysEarly).toBe(-7);
    expect(describeEta(p!.daysEarly!)).toBe("~7 days late");
  });

  it("moving AWAY: trend heads away from the target (never reaches)", () => {
    const rising: ProjectionPoint[] = [
      { date: "2026-01-01", value: 90 },
      { date: "2026-01-08", value: 91 },
      { date: "2026-01-15", value: 92 },
      { date: "2026-01-22", value: 93 },
    ];
    const p = projectGoal(rising, 85, "2026-03-01");
    expect(p?.status).toBe("away");
    expect(p?.projectedDate).toBeNull();
    expect(p?.daysEarly).toBeNull();
  });

  it("returns null for insufficient data (fewer than the minimum points)", () => {
    const few = LOSS.slice(0, MIN_PROJECTION_POINTS - 1);
    expect(projectGoal(few, 85, null)).toBeNull();
  });

  it("returns null for a flat trend (no slope → no sane ETA)", () => {
    const flat: ProjectionPoint[] = [
      { date: "2026-01-01", value: 87 },
      { date: "2026-01-08", value: 87 },
      { date: "2026-01-15", value: 87 },
      { date: "2026-01-22", value: 87 },
    ];
    expect(projectGoal(flat, 85, null)).toBeNull();
  });

  it("returns null when the target is already reached (overshot in the goal direction)", () => {
    // A reduce-to-88 goal (baseline 92): the series has already dropped to 87,
    // below 88, so the goal is met — no ETA. Without the baseline the same points
    // would read as "away" (a decreasing trend moving off an 88 target), so this
    // exercises the direction disambiguation.
    expect(projectGoal(LOSS, 88, null, 92)).toBeNull();
  });

  it("trending AWAY from a reduce goal (baseline fixes the direction)", () => {
    // Want to cut to 80 from a baseline of 85, but weight is climbing.
    const climbing: ProjectionPoint[] = [
      { date: "2026-01-01", value: 85 },
      { date: "2026-01-08", value: 86 },
      { date: "2026-01-15", value: 87 },
      { date: "2026-01-22", value: 88 },
    ];
    const p = projectGoal(climbing, 80, "2026-04-01", 85);
    expect(p?.status).toBe("away");
    expect(p?.projectedDate).toBeNull();
  });

  it("returns null when a near-flat pace pushes the ETA past the horizon", () => {
    // ~0.0001/week over ~3 weeks toward a target 2 units away → tens of thousands
    // of years out; treated as flat.
    const creep: ProjectionPoint[] = [
      { date: "2026-01-01", value: 90.0 },
      { date: "2026-01-08", value: 89.9999 },
      { date: "2026-01-15", value: 89.9998 },
      { date: "2026-01-22", value: 89.9997 },
    ];
    expect(projectGoal(creep, 85, null)).toBeNull();
  });
});

describe("describeEta", () => {
  it("reads as on track within the slack window", () => {
    expect(describeEta(0)).toBe("on track");
    expect(describeEta(3)).toBe("on track");
    expect(describeEta(-3)).toBe("on track");
  });
  it("uses days under two weeks and weeks beyond", () => {
    expect(describeEta(10)).toBe("~10 days early");
    expect(describeEta(-10)).toBe("~10 days late");
    expect(describeEta(21)).toBe("~3 weeks early");
    expect(describeEta(-14)).toBe("~2 weeks late");
  });
});
