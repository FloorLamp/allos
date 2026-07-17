import { describe, it, expect } from "vitest";
import {
  foodHabitSignalKey,
  isFoodHabitBehind,
  FOOD_HABIT_PREFIX,
  FOOD_GROUP_INTERACTION_KEYS,
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "@/lib/food-habit";
import { matchFoodInteractions } from "@/lib/food-drug-interactions";
import { isValidFoodGroup } from "@/lib/food-groups";
import type { SafetyMedication } from "@/lib/supplement-safety";
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
    pace: count >= perWeek ? "met" : "behind",
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

// ---- Food–drug interaction screen for habit targets (#661) ----

const warfarin: SafetyMedication = {
  name: "Warfarin",
  rxcui: null,
  rxcuiIngredients: null,
};
const atorvastatin: SafetyMedication = {
  name: "Atorvastatin",
  rxcui: null,
  rxcuiIngredients: null,
};

describe("foodHabitInteractions (#661)", () => {
  it("warns when a leafy-greens habit meets warfarin — the SAME hit the med row shows", () => {
    const hits = foodHabitInteractions("leafy_greens", [warfarin]);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("vitamin-k-warfarin");
    expect(hits[0].medication).toBe("Warfarin");
    // Parity: the advice is literally what matchFoodInteractions(warfarin) carries for
    // the same entry — one computation, two surfaces (#661.3).
    const medHit = matchFoodInteractions(warfarin).find(
      (h) => h.key === "vitamin-k-warfarin"
    );
    expect(hits[0].advice).toBe(medHit?.advice);
    expect(foodHabitInteractionNote(hits[0])).toContain("Warfarin");
    expect(foodHabitInteractionNote(hits[0])).toBe(
      `You take Warfarin — ${medHit?.advice}`
    );
  });

  it("does not warn when the habit's group is unrelated to the stack", () => {
    // Leafy greens do not conflict with a statin; grapefruit would, but there is no
    // grapefruit food group (deliberately unmapped — no over-warning of fruit habits).
    expect(foodHabitInteractions("leafy_greens", [atorvastatin])).toEqual([]);
    // An unmapped group (fruit) never warns even with a relevant med.
    expect(foodHabitInteractions("fruit", [atorvastatin])).toEqual([]);
  });

  it("returns nothing for an empty stack", () => {
    expect(foodHabitInteractions("leafy_greens", [])).toEqual([]);
  });
});

describe("FOOD_GROUP_INTERACTION_KEYS anti-drift (#661)", () => {
  it("every mapped slug is a real food group and every key a real interaction entry", async () => {
    const { FOOD_DRUG_INTERACTIONS } =
      await import("@/lib/datasets/food-drug-interactions");
    const entryKeys = new Set(FOOD_DRUG_INTERACTIONS.map((e) => e.key));
    for (const [slug, keys] of Object.entries(FOOD_GROUP_INTERACTION_KEYS)) {
      expect(isValidFoodGroup(slug), `unknown food group: ${slug}`).toBe(true);
      for (const k of keys) {
        expect(entryKeys.has(k), `unknown interaction key: ${k}`).toBe(true);
      }
    }
  });
});
