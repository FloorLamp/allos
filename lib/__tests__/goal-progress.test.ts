import { describe, it, expect } from "vitest";
import {
  computeGoalProgress,
  computeBodyGoalProgress,
  type GoalSetRow,
} from "../goal-progress";
import type { Goal } from "../types";

// Minimal Goal factory — only the fields the progress functions read matter.
function goal(overrides: Partial<Goal>): Goal {
  return {
    id: 1,
    title: "Goal",
    description: null,
    category: null,
    target_value: null,
    current_value: null,
    unit: null,
    target_date: null,
    status: "active",
    created_at: "2026-01-01",
    exercise: null,
    metric: null,
    target_weight_kg: null,
    target_reps: null,
    target_sets: null,
    target_duration_sec: null,
    body_metric: null,
    baseline_value: null,
    archived: 0,
    ...overrides,
  };
}

describe("computeBodyGoalProgress", () => {
  it("null current is never done", () => {
    const g = goal({
      body_metric: "weight",
      target_value: 80,
      baseline_value: 90,
    });
    expect(computeBodyGoalProgress(g, null)).toEqual({
      current: 0,
      target: 80,
      pct: 0,
      done: false,
    });
  });

  it("maintain goal (baseline === target): done only when current is at target", () => {
    const g = goal({
      body_metric: "weight",
      target_value: 80,
      baseline_value: 80,
    });
    // At target → achieved.
    expect(computeBodyGoalProgress(g, 80)).toEqual({
      current: 80,
      target: 80,
      pct: 100,
      done: true,
    });
    // Above target → NOT achieved (the old bug reported done forever here).
    const over = computeBodyGoalProgress(g, 85);
    expect(over.done).toBe(false);
    expect(over.pct).toBe(0);
    // Below target → NOT achieved either.
    expect(computeBodyGoalProgress(g, 75).done).toBe(false);
  });

  it("null baseline: completes when current reaches target", () => {
    const g = goal({
      body_metric: "weight",
      target_value: 80,
      baseline_value: null,
    });
    // Reaching the target now counts as done (was impossible before).
    expect(computeBodyGoalProgress(g, 80)).toEqual({
      current: 80,
      target: 80,
      pct: 100,
      done: true,
    });
    // Not yet at target → not done.
    expect(computeBodyGoalProgress(g, 82).done).toBe(false);
  });

  it("gain direction: baseline < target reads 0→100%", () => {
    const g = goal({
      body_metric: "weight",
      target_value: 100,
      baseline_value: 80,
    });
    expect(computeBodyGoalProgress(g, 80).pct).toBe(0); // at baseline
    expect(computeBodyGoalProgress(g, 90).pct).toBe(50); // halfway
    const done = computeBodyGoalProgress(g, 100);
    expect(done.pct).toBe(100);
    expect(done.done).toBe(true);
    // Overshoot clamps at 100.
    expect(computeBodyGoalProgress(g, 110).pct).toBe(100);
  });

  it("reduction direction: baseline > target reads 0→100%", () => {
    // Lose weight: 90 → 80.
    const g = goal({
      body_metric: "weight",
      target_value: 80,
      baseline_value: 90,
    });
    expect(computeBodyGoalProgress(g, 90).pct).toBe(0); // at baseline
    expect(computeBodyGoalProgress(g, 85).pct).toBe(50); // halfway
    const done = computeBodyGoalProgress(g, 80);
    expect(done.pct).toBe(100);
    expect(done.done).toBe(true);
    // Going below target still clamps at 100 (done).
    expect(computeBodyGoalProgress(g, 75).pct).toBe(100);
    // Moving the wrong way clamps at 0.
    expect(computeBodyGoalProgress(g, 95).pct).toBe(0);
  });
});

describe("computeGoalProgress", () => {
  const set = (o: Partial<GoalSetRow>): GoalSetRow => ({
    activity_id: 1,
    exercise: "Bench Press",
    weight_kg: null,
    reps: null,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    ...o,
  });

  it("weight metric: best set weight vs target", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const p = computeGoalProgress(g, [
      set({ weight_kg: 80 }),
      set({ weight_kg: 100 }),
    ]);
    expect(p.current).toBe(100);
    expect(p.done).toBe(true);
    expect(p.pct).toBe(100);
  });

  it("weight metric: below target is partial and not done", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const p = computeGoalProgress(g, [set({ weight_kg: 50 })]);
    expect(p.pct).toBe(50);
    expect(p.done).toBe(false);
  });

  it("reps metric respects the weight floor", () => {
    const g = goal({ metric: "reps", target_reps: 5, target_weight_kg: 60 });
    // A set under the floor doesn't count.
    expect(
      computeGoalProgress(g, [set({ weight_kg: 50, reps: 10 })]).current
    ).toBe(0);
    // A set at/above the floor counts its reps.
    expect(computeGoalProgress(g, [set({ weight_kg: 60, reps: 5 })]).done).toBe(
      true
    );
  });

  it("no matching sets yields zeroed progress", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const p = computeGoalProgress(g, []);
    expect(p).toEqual({
      current: 0,
      target: 100,
      pct: 0,
      done: false,
      lifetimeBest: 0,
    });
  });

  it("without a today, current equals the lifetime best (backward compatible)", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const p = computeGoalProgress(g, [
      set({ weight_kg: 80, date: "2020-01-01" }),
      set({ weight_kg: 100, date: "2026-06-01" }),
    ]);
    // No windowing → current is the all-time max, same as lifetimeBest.
    expect(p.current).toBe(100);
    expect(p.lifetimeBest).toBe(100);
    expect(p.done).toBe(true);
  });

  it("with a today, current is the best in the trailing 28-day window; PR survives as lifetimeBest", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const today = "2026-07-09";
    const p = computeGoalProgress(
      g,
      [
        // Lifetime PR, but well outside the 28-day window (detrained).
        set({ weight_kg: 100, date: "2026-01-01" }),
        // Recent, lighter working set.
        set({ weight_kg: 70, date: "2026-07-01" }),
      ],
      today
    );
    expect(p.current).toBe(70); // recent form, not the stale PR
    expect(p.lifetimeBest).toBe(100); // PR still exposed
    expect(p.pct).toBe(70);
    // done keys off the LIFETIME best: the target was genuinely hit once, so the
    // achievement stands ("Mark achieved" stays tinted) even though the bar has
    // dropped back to recent form.
    expect(p.done).toBe(true);
  });

  it("done is false when the target was never hit, in or out of the window", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const p = computeGoalProgress(
      g,
      [
        set({ weight_kg: 90, date: "2026-01-01" }),
        set({ weight_kg: 70, date: "2026-07-01" }),
      ],
      "2026-07-09"
    );
    expect(p.done).toBe(false);
    expect(p.lifetimeBest).toBe(90);
  });

  it("window edge: a set exactly 27 days back counts, 28 days back does not", () => {
    const g = goal({ metric: "weight", target_weight_kg: 100 });
    const today = "2026-07-28";
    // 28-day inclusive window = today back through 2026-07-01.
    const inWindow = computeGoalProgress(
      g,
      [set({ weight_kg: 100, date: "2026-07-01" })],
      today
    );
    expect(inWindow.current).toBe(100);
    const outOfWindow = computeGoalProgress(
      g,
      [set({ weight_kg: 100, date: "2026-06-30" })],
      today
    );
    expect(outOfWindow.current).toBe(0);
    expect(outOfWindow.lifetimeBest).toBe(100);
  });

  it("sets metric windows per session and still exposes the lifetime best", () => {
    const g = goal({ metric: "sets", target_sets: 3, target_reps: 5 });
    const today = "2026-07-09";
    const sets = [
      // Old session: 3 qualifying sets (lifetime best = 3).
      set({ activity_id: 1, reps: 5, date: "2026-01-01" }),
      set({ activity_id: 1, reps: 5, date: "2026-01-01" }),
      set({ activity_id: 1, reps: 5, date: "2026-01-01" }),
      // Recent session: only 2 qualifying sets.
      set({ activity_id: 2, reps: 5, date: "2026-07-05" }),
      set({ activity_id: 2, reps: 5, date: "2026-07-05" }),
    ];
    const p = computeGoalProgress(g, sets, today);
    expect(p.current).toBe(2);
    expect(p.lifetimeBest).toBe(3);
  });
});
