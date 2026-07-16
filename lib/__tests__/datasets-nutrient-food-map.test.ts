import { describe, expect, it } from "vitest";
import {
  nutrientFoodMapDataset,
  nutrientFoodEntryForKey,
  nutrientKeyStrategy,
  NUTRIENT_FOOD_ENTRIES,
  REDUCE_FOOD_ENTRIES,
} from "@/lib/datasets/nutrient-food-map";
import { citationPresent, identityResolves, refusalGate } from "@/lib/datasets";

// Framework-contract tests for the nutrient-food-map dataset (issue #860 Track B),
// migrated onto lib/datasets/. These exercise the reusable harness assertions
// (citation-present, identity-resolves, refusal-gate) against the real loaded dataset,
// and pin the behavior-identical key lookup + the two entry sets the food engines rely
// on. Pure — no DB, no network. (Anti-drift / fixed-point + cross-reference pins live
// in nutrient-food-map-dataset.test.ts.)

describe("nutrient-food-map dataset on the curated-dataset framework", () => {
  it("carries a citation with a source", () => {
    const r = citationPresent(nutrientFoodMapDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(nutrientFoodMapDataset.citation[0].source).toMatch(/NIH|ODS/i);
  });

  it("resolves every low entry by its own identity (nutrient key)", () => {
    const r = identityResolves(nutrientFoodMapDataset, nutrientKeyStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent nutrient key (returns null — never a guess)", () => {
    const r = refusalGate(nutrientFoodMapDataset, nutrientKeyStrategy, [
      "__no_such_nutrient__",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(nutrientFoodEntryForKey("__no_such_nutrient__")).toBeNull();
  });

  it("exposes both entry sets (low ADD + high-side REDUCE via meta)", () => {
    expect(NUTRIENT_FOOD_ENTRIES.length).toBeGreaterThan(0);
    expect(REDUCE_FOOD_ENTRIES.length).toBeGreaterThan(0);
    const omega = nutrientFoodEntryForKey("omega-3");
    expect(omega).toBeTruthy();
    expect(omega!.direction).toBe("low");
    for (const e of REDUCE_FOOD_ENTRIES) expect(e.direction).toBe("high");
  });
});
