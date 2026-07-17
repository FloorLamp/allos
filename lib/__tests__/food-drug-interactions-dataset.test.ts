import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFoodDrugInteractionsDataset } from "@/scripts/gen-food-drug-interactions";
import dataset from "@/lib/datasets/data/food-drug-interactions.json";
import {
  foodDrugInteractionsDataset,
  foodDrugKeyStrategy,
} from "@/lib/datasets/food-drug-interactions";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { matchFoodInteractions } from "@/lib/food-drug-interactions";

// Anti-drift + framework-contract pins for the baked food–drug interaction dataset
// (issue #154, migrated onto the curated-dataset framework in #860 Track B). This is a
// HAND-MAINTAINED dataset migrated with a NEW generator + fixed-point test (it had
// neither before). The committed lib/datasets/data JSON must be a FIXED POINT of the
// generator, pass the framework harness (citation / identity / refusal / no-collisions),
// and the domain matcher must stay behavior-identical (the guidance the med cards + e2e
// suite rely on). Pure — reads the generator + the committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/food-drug-interactions.json");

const SEVERITIES = new Set(["major", "moderate", "minor"]);

describe("food-drug-interactions.json dataset", () => {
  it("is a fixed point of buildFoodDrugInteractionsDataset() (regenerate with `npm run gen:food-drug-interactions`)", () => {
    const generated =
      JSON.stringify(buildFoodDrugInteractionsDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity slug / refusal / no collisions)", () => {
    const r = runHarness(foodDrugInteractionsDataset, foodDrugKeyStrategy);
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a citation with a public-domain source", () => {
    const r = citationPresent(foodDrugInteractionsDataset);
    expect(r.problems).toEqual([]);
    expect(foodDrugInteractionsDataset.citation[0].source).toMatch(
      /DailyMed|FDA|MedlinePlus|RxNorm/i
    );
  });

  it("resolves every entry by its own slug identity, with no collisions", () => {
    expect(
      identityResolves(foodDrugInteractionsDataset, foodDrugKeyStrategy)
        .problems
    ).toEqual([]);
    expect(
      noKeyCollisions(foodDrugInteractionsDataset, foodDrugKeyStrategy).problems
    ).toEqual([]);
  });

  it("refuses an absent rule key (returns null — never a guess)", () => {
    expect(
      refusalGate(foodDrugInteractionsDataset, foodDrugKeyStrategy, [
        "no-such-rule",
        "",
      ]).problems
    ).toEqual([]);
  });

  it("gives every entry a unique key, a legal severity, and cited guidance", () => {
    const keys = new Set<string>();
    for (const e of dataset.entries) {
      expect(e.key.trim().length, e.key).toBeGreaterThan(0);
      expect(keys.has(e.key), `duplicate ${e.key}`).toBe(false);
      keys.add(e.key);
      expect(SEVERITIES.has(e.severity), e.severity).toBe(true);
      expect(e.food.trim().length, e.key).toBeGreaterThan(0);
      expect(e.advice.trim().length, e.key).toBeGreaterThan(0);
      expect(e.mechanism.trim().length, e.key).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      expect(Array.isArray(e.rxcuis), e.key).toBe(true);
      expect(Array.isArray(e.synonyms), e.key).toBe(true);
      expect(e.rxcuis.length + e.synonyms.length, e.key).toBeGreaterThan(0);
    }
  });
});

describe("domain matcher is behavior-identical (the accessor pin)", () => {
  it("REGRESSION: the seeded Simvastatin → grapefruit guidance (e2e-relied)", () => {
    const hit = matchFoodInteractions({
      name: "Simvastatin 40mg",
      rxcui: null,
    }).find((h) => h.key === "grapefruit-statin");
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe("major");
    expect(hit!.advice.toLowerCase()).toContain("grapefruit");
    expect(hit!.source.length).toBeGreaterThan(0);
  });

  it("REGRESSION: the seeded Warfarin → vitamin-K (+ alcohol) guidance (e2e-relied)", () => {
    const keys = matchFoodInteractions({
      name: "Warfarin",
      rxcui: "11289",
    }).map((h) => h.key);
    expect(keys).toContain("vitamin-k-warfarin");
    expect(keys).toContain("alcohol-warfarin");
  });

  it("resolves by RxCUI when the name is unhelpful, and refuses an unknown item", () => {
    expect(
      matchFoodInteractions({ name: "Generic tablet A", rxcui: "36567" }).map(
        (h) => h.key
      )
    ).toContain("grapefruit-statin");
    expect(
      matchFoodInteractions({ name: "Vitamin D3 2000 IU", rxcui: null })
    ).toHaveLength(0);
  });
});
