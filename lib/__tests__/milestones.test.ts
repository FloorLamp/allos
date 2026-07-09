import { describe, expect, it } from "vitest";
import {
  detectMilestones,
  adherenceRunLength,
  reachedThreshold,
  WORKOUT_THRESHOLDS,
  STREAK_THRESHOLDS,
  ADHERENCE_RUN_THRESHOLDS,
  type MilestoneInput,
  type AdherenceDay,
} from "@/lib/milestones";

function input(over: Partial<MilestoneInput> = {}): MilestoneInput {
  return {
    totalWorkouts: 0,
    streak: 0,
    adherenceRun: 0,
    completedGoals: [],
    fired: new Set<string>(),
    ...over,
  };
}

describe("reachedThreshold", () => {
  it("returns the largest reached threshold, or null when none", () => {
    expect(reachedThreshold(4, WORKOUT_THRESHOLDS)).toBeNull();
    expect(reachedThreshold(10, WORKOUT_THRESHOLDS)).toBe(10);
    expect(reachedThreshold(120, WORKOUT_THRESHOLDS)).toBe(100);
    expect(reachedThreshold(9999, WORKOUT_THRESHOLDS)).toBe(500);
  });
});

describe("detectMilestones — workout counts", () => {
  it("does not fire below the first threshold", () => {
    expect(detectMilestones(input({ totalWorkouts: 9 }))).toEqual([]);
  });

  it("fires exactly at each threshold boundary", () => {
    for (const t of WORKOUT_THRESHOLDS) {
      const fired = detectMilestones(input({ totalWorkouts: t }));
      expect(fired.some((m) => m.key === `workouts:${t}`)).toBe(true);
    }
  });

  it("fires every crossed threshold at once for a big jump (import backfill)", () => {
    const fired = detectMilestones(input({ totalWorkouts: 300 }));
    expect(fired.map((m) => m.key)).toEqual([
      "workouts:10",
      "workouts:50",
      "workouts:100",
      "workouts:250",
    ]);
  });

  it("never re-fires an already-recorded milestone", () => {
    const fired = detectMilestones(
      input({
        totalWorkouts: 120,
        fired: new Set(["workouts:10", "workouts:50", "workouts:100"]),
      })
    );
    expect(fired).toEqual([]);
  });
});

describe("detectMilestones — streaks", () => {
  it("fires at each streak length threshold", () => {
    for (const t of STREAK_THRESHOLDS) {
      const fired = detectMilestones(input({ streak: t }));
      expect(fired.some((m) => m.key === `streak:${t}`)).toBe(true);
    }
  });

  it("does not fire a streak below the first threshold", () => {
    expect(detectMilestones(input({ streak: 6 }))).toEqual([]);
  });
});

describe("detectMilestones — adherence runs", () => {
  it("fires at each adherence run threshold", () => {
    for (const t of ADHERENCE_RUN_THRESHOLDS) {
      const fired = detectMilestones(input({ adherenceRun: t }));
      expect(fired.some((m) => m.key === `adherence:${t}`)).toBe(true);
    }
  });
});

describe("detectMilestones — goals", () => {
  it("fires once per completed goal, keyed by id, in id order", () => {
    const fired = detectMilestones(
      input({
        completedGoals: [
          { id: 5, title: "Run a 10k" },
          { id: 2, title: "Squat bodyweight" },
        ],
      })
    );
    expect(fired.map((m) => m.key)).toEqual(["goal:2", "goal:5"]);
    expect(fired[0].title).toContain("Squat bodyweight");
  });

  it("does not re-fire a goal already recorded", () => {
    const fired = detectMilestones(
      input({
        completedGoals: [{ id: 2, title: "Squat bodyweight" }],
        fired: new Set(["goal:2"]),
      })
    );
    expect(fired).toEqual([]);
  });
});

describe("detectMilestones — ordering across families", () => {
  it("emits workouts, then streak, then adherence, then goals", () => {
    const fired = detectMilestones(
      input({
        totalWorkouts: 10,
        streak: 7,
        adherenceRun: 7,
        completedGoals: [{ id: 1, title: "Goal" }],
      })
    );
    expect(fired.map((m) => m.kind)).toEqual([
      "workouts",
      "streak",
      "adherence",
      "goal",
    ]);
  });
});

describe("adherenceRunLength", () => {
  const day = (due: number, taken: number): AdherenceDay => ({ due, taken });

  it("is zero when no day had anything due", () => {
    expect(adherenceRunLength([day(0, 0), day(0, 0)])).toBe(0);
  });

  it("counts consecutive perfect days ending at the most recent", () => {
    // oldest → newest: all fully taken
    expect(adherenceRunLength([day(2, 2), day(1, 1), day(3, 3)])).toBe(3);
  });

  it("treats not-due days as transparent (neither extend nor break)", () => {
    // A gap day with nothing due sits between two perfect days.
    expect(adherenceRunLength([day(1, 1), day(0, 0), day(2, 2)])).toBe(2);
  });

  it("breaks the run on a missed due dose", () => {
    // oldest perfect, then a partial miss, then perfect — only the trailing run counts.
    expect(
      adherenceRunLength([day(2, 2), day(2, 1), day(1, 1), day(1, 1)])
    ).toBe(2);
  });

  it("a partial (taken < due) most-recent day yields a zero run", () => {
    expect(adherenceRunLength([day(2, 2), day(2, 1)])).toBe(0);
  });
});
