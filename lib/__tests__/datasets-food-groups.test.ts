import { describe, expect, it } from "vitest";
import {
  foodGroupsDataset,
  foodGroupBySlug,
  canonicalFoodGroup,
  FOOD_GROUPS,
} from "@/lib/datasets/food-groups";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  slugStrategy,
} from "@/lib/datasets";

// Framework-contract tests for the food-groups dataset (issue #860 Track B), migrated
// onto lib/datasets/. These exercise the reusable harness assertions (citation-present,
// identity-resolves, refusal-gate) against the real loaded dataset, and pin the
// behavior-identical slug lookup the food log relies on. Pure — no DB, no network.
// (Anti-drift / fixed-point + cross-reference pins live in food-groups-dataset.test.ts.)

describe("food-groups dataset on the curated-dataset framework", () => {
  it("carries a citation with a source (USDA FoodData Central)", () => {
    const r = citationPresent(foodGroupsDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(foodGroupsDataset.citation[0].source).toMatch(/USDA/i);
  });

  it("resolves every entry by its own identity (slug)", () => {
    const r = identityResolves(foodGroupsDataset, slugStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent slug (returns undefined — never a guess)", () => {
    const r = refusalGate(foodGroupsDataset, slugStrategy, [
      "__no_such_group__",
      "",
      "   ",
    ]);
    expect(r.problems).toEqual([]);
    expect(foodGroupBySlug("__no_such_group__")).toBeUndefined();
  });

  it("resolves a known slug (behavior-identical lookup)", () => {
    const fatty = foodGroupBySlug("fatty_fish");
    expect(fatty).toBeTruthy();
    expect(fatty!.name).toBe("Fatty fish");
    expect(fatty!.tier).toBe("encourage");
    expect(FOOD_GROUPS.length).toBeGreaterThanOrEqual(20);
  });

  it("canonicalFoodGroup returns the catalog slug for case/punctuation variants (#883)", () => {
    // The value the write paths persist — always the canonical slug, never the raw input.
    expect(canonicalFoodGroup("leafy_greens")).toBe("leafy_greens");
    expect(canonicalFoodGroup("Leafy_Greens")).toBe("leafy_greens");
    expect(canonicalFoodGroup("leafy-greens")).toBe("leafy_greens");
    expect(canonicalFoodGroup("  leafy_greens  ")).toBe("leafy_greens");
  });

  it("canonicalFoodGroup refuses an unknown group with null (the refusal gate)", () => {
    expect(canonicalFoodGroup("__no_such_group__")).toBeNull();
    expect(canonicalFoodGroup("")).toBeNull();
  });
});
