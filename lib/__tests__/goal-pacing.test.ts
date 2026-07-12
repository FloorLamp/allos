import { describe, it, expect } from "vitest";
import {
  assessGoalPace,
  detectFastWeightLoss,
  goalPaceSignalKey,
  weightLossRateSignalKey,
  GOAL_PACE_PREFIX,
  type PaceableGoal,
} from "@/lib/goal-pacing";
import type { ProjectionPoint } from "@/lib/trend-projection";
import type { DatedPoint } from "@/lib/robust-stats";

// A steady -1 kg/week loss, last reading 2026-01-22. At this pace 85 kg is reached
// 2026-02-05 (matches the trend-projection fixtures).
const LOSS: ProjectionPoint[] = [
  { date: "2026-01-01", value: 90 },
  { date: "2026-01-08", value: 89 },
  { date: "2026-01-15", value: 88 },
  { date: "2026-01-22", value: 87 },
];

const goal = (over: Partial<PaceableGoal>): PaceableGoal => ({
  id: 7,
  title: "Cut to 85 kg",
  targetValue: 85,
  targetDate: "2026-02-05",
  baselineValue: 90,
  ...over,
});

describe("assessGoalPace", () => {
  it("returns null when the goal will land on time", () => {
    // Projected 2026-02-05, deadline the same day → on track.
    expect(assessGoalPace(goal({}), LOSS)).toBeNull();
  });

  it("flags a goal that will land well past its deadline as late", () => {
    // Deadline a week before the projected reach date → 7 days late.
    const f = assessGoalPace(goal({ targetDate: "2026-01-29" }), LOSS);
    expect(f?.status).toBe("late");
    expect(f?.daysLate).toBe(7);
    expect(f?.goalId).toBe(7);
  });

  it("does NOT flag a miss within the on-track slack", () => {
    // 2 days late is inside PACE_SLACK_DAYS (±3) → treated as on track.
    expect(assessGoalPace(goal({ targetDate: "2026-02-03" }), LOSS)).toBeNull();
  });

  it("flags a goal the trend is moving away from", () => {
    const rising: ProjectionPoint[] = [
      { date: "2026-01-01", value: 85 },
      { date: "2026-01-08", value: 86 },
      { date: "2026-01-15", value: 87 },
      { date: "2026-01-22", value: 88 },
    ];
    const f = assessGoalPace(
      goal({ targetValue: 80, baselineValue: 85, targetDate: "2026-04-01" }),
      rising
    );
    expect(f?.status).toBe("away");
    expect(f?.daysLate).toBeNull();
  });
});

describe("detectFastWeightLoss", () => {
  const today = "2026-03-01";
  const daysAgo = (n: number) => {
    const d = new Date(Date.UTC(2026, 2, 1) - n * 86_400_000);
    return d.toISOString().slice(0, 10);
  };

  it("cautions on a sustained loss faster than ~1%/week", () => {
    // 80 → 76 over 28 days (~1 kg/week off ~78 → ~1.28%/week).
    const pts: DatedPoint[] = [28, 21, 14, 7, 0].map((n) => ({
      date: daysAgo(n),
      value: 80 - (28 - n) / 7,
    }));
    const c = detectFastWeightLoss(pts, today);
    expect(c).not.toBeNull();
    expect(c!.fractionPerWeek).toBeGreaterThan(0.01);
  });

  it("stays quiet for a slow, safe loss", () => {
    // ~0.18 kg/week off ~83 → ~0.22%/week (the seed's gentle cut).
    const pts: DatedPoint[] = [28, 21, 14, 7, 0].map((n) => ({
      date: daysAgo(n),
      value: 83 - (28 - n) * (0.18 / 7),
    }));
    expect(detectFastWeightLoss(pts, today)).toBeNull();
  });

  it("stays quiet when gaining weight", () => {
    const pts: DatedPoint[] = [28, 21, 14, 7, 0].map((n) => ({
      date: daysAgo(n),
      value: 78 + (28 - n) / 7,
    }));
    expect(detectFastWeightLoss(pts, today)).toBeNull();
  });

  it("needs enough points to judge a rate", () => {
    const pts: DatedPoint[] = [14, 7, 0].map((n) => ({
      date: daysAgo(n),
      value: 80 - (14 - n) / 3,
    }));
    expect(detectFastWeightLoss(pts, today)).toBeNull();
  });
});

describe("signal keys", () => {
  it("share the goal-pace namespace", () => {
    expect(goalPaceSignalKey(3).startsWith(GOAL_PACE_PREFIX)).toBe(true);
    // #436: the safe-rate caution key now carries the loss window's start month.
    expect(
      weightLossRateSignalKey("2026-03").startsWith(GOAL_PACE_PREFIX)
    ).toBe(true);
  });
});
