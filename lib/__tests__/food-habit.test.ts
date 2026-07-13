import { describe, it, expect } from "vitest";
import {
  foodHabitSignalKey,
  isFoodHabitBehind,
  FOOD_HABIT_PREFIX,
} from "@/lib/food-habit";
import type { FrequencyTargetProgress } from "@/lib/queries/training/goals";

// Pure-tier tests for the food-habit finding identity + behind decision (#580).

function progress(
  scopeKind: "food_group" | "type",
  scopeValue: string,
  count: number,
  perWeek: number
): FrequencyTargetProgress {
  return {
    target: {
      id: 1,
      scope_kind: scopeKind,
      scope_value: scopeValue,
      per_week: perWeek,
      created_at: "2026-01-01",
    },
    count,
    per_week: perWeek,
    met: count >= perWeek,
  };
}

describe("foodHabitSignalKey", () => {
  it("keys on the group slug under the food-habit namespace", () => {
    expect(foodHabitSignalKey("fatty_fish")).toBe(
      `${FOOD_HABIT_PREFIX}fatty_fish`
    );
  });
});

describe("isFoodHabitBehind", () => {
  it("is true for a food_group target below its per-week", () => {
    expect(isFoodHabitBehind(progress("food_group", "fatty_fish", 1, 2))).toBe(
      true
    );
  });

  it("is false when the target is met or exceeded", () => {
    expect(isFoodHabitBehind(progress("food_group", "fatty_fish", 2, 2))).toBe(
      false
    );
    expect(isFoodHabitBehind(progress("food_group", "fatty_fish", 3, 2))).toBe(
      false
    );
  });

  it("ignores non-food_group (training) targets", () => {
    expect(isFoodHabitBehind(progress("type", "cardio", 0, 4))).toBe(false);
  });
});
