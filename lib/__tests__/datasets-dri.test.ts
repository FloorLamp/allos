import { describe, expect, it } from "vitest";
import {
  driDataset,
  driNutrientForKey,
  driNutrientStrategy,
  DRI_NUTRIENTS,
} from "@/lib/datasets/dri";
import { citationPresent, identityResolves, refusalGate } from "@/lib/datasets";

// Framework-contract tests for the dri dataset (issue #860 Track B), migrated onto
// lib/datasets/. These exercise the reusable harness assertions (citation-present,
// identity-resolves, refusal-gate) against the real loaded dataset, and pin the
// behavior-identical nutrient-key lookup the UL/RDA checker relies on. Pure — no DB,
// no network. (Anti-drift / fixed-point + band-shape pins live in dri-dataset.test.ts.)

describe("dri dataset on the curated-dataset framework", () => {
  it("carries a citation with a source (National Academies / NIH ODS)", () => {
    const r = citationPresent(driDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(driDataset.citation[0].source).toMatch(
      /National Academies|NIH|DRI/i
    );
  });

  it("resolves every entry by its own identity (nutrient key)", () => {
    const r = identityResolves(driDataset, driNutrientStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent nutrient key (returns null — never a guess)", () => {
    const r = refusalGate(driDataset, driNutrientStrategy, [
      "__no_such_nutrient__",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(driNutrientForKey("__no_such_nutrient__")).toBeNull();
  });

  it("resolves a known nutrient with bands (behavior-identical lookup)", () => {
    const mag = driNutrientForKey("magnesium");
    expect(mag).toBeTruthy();
    expect(mag!.key).toBe("magnesium");
    expect(mag!.bands.length).toBeGreaterThan(0);
    expect(DRI_NUTRIENTS.length).toBeGreaterThan(0);
  });
});
