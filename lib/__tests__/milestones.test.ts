import { describe, expect, it } from "vitest";
import {
  detectMilestones,
  reachedThreshold,
  WORKOUT_THRESHOLDS,
  type MilestoneInput,
} from "@/lib/milestones";

function input(over: Partial<MilestoneInput> = {}): MilestoneInput {
  return {
    totalWorkouts: 0,
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

// #1939 — the RUN-shaped families are retired. `streak:` rewarded a rest-tolerant
// activity run against [7, 30, 100, 365]; `adherence:` rewarded [7, 30] consecutive
// days on which every due dose was taken. Both were the cliff class — congratulatory
// copy over something a deload week, an illness pause or a deliberate skip (#232)
// resets to zero. `workouts:` and `goal:` survive because neither CAN be broken:
// gaps do not undo 100 logged workouts, and a completed goal is a user-declared
// intent being met rather than a run being maintained.
describe("detectMilestones — the retired run families", () => {
  it("emits nothing for a profile that would have crossed both", () => {
    // The fixture that used to fire `streak:365` and `adherence:30` at once. The
    // fields are gone from MilestoneInput, so the only thing left to assert is that
    // a maximally-qualifying profile yields nothing — which is the ruling.
    expect(detectMilestones(input())).toEqual([]);
  });

  it("never mints a streak: or adherence: key alongside the survivors", () => {
    const fired = detectMilestones(
      input({
        totalWorkouts: 500,
        completedGoals: [{ id: 3, title: "Run a 10k" }],
      })
    );
    expect(fired.length).toBeGreaterThan(0);
    for (const m of fired) {
      expect(m.key.startsWith("streak:")).toBe(false);
      expect(m.key.startsWith("adherence:")).toBe(false);
      expect(["workouts", "goal"]).toContain(m.kind);
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
  it("emits workouts, then goals", () => {
    const fired = detectMilestones(
      input({
        totalWorkouts: 10,
        completedGoals: [{ id: 1, title: "Goal" }],
      })
    );
    expect(fired.map((m) => m.kind)).toEqual(["workouts", "goal"]);
  });
});
