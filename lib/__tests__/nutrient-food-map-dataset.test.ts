import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNutrientFoodMap } from "@/scripts/gen-nutrient-food-map";
import {
  nutrientFoodMapBiomarkers,
  nutrientFoodMapDrugKeys,
} from "@/lib/food-suggest";
import canonicalSeed from "@/lib/canonical-biomarkers.json";
import foodDrug from "@/lib/food-drug-interactions.json";

// Anti-drift pins for the baked biomarker→food map (issue #577): the committed
// lib/nutrient-food-map.json must be a FIXED POINT of the generator; every biomarker
// name it references must resolve to a canonical biomarker; every food–drug entry key
// it references must exist in lib/food-drug-interactions.json. Pure — no DB/network.
// (The food_group slug cross-reference into lib/food-groups.json is pinned in #579's
// dataset test, once that file exists.)

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/nutrient-food-map.json");

const CANONICAL_NAMES = new Set(
  ((canonicalSeed as { biomarkers?: { name: string }[] }).biomarkers ?? []).map(
    (b) => b.name.toLowerCase()
  )
);
const DRUG_KEYS = new Set(
  ((foodDrug as { interactions?: { key: string }[] }).interactions ?? []).map(
    (e) => e.key
  )
);

describe("nutrient-food-map.json dataset", () => {
  it("is a fixed point of buildNutrientFoodMap() (regenerate with `npm run gen:nutrient-food-map`)", () => {
    const generated = JSON.stringify(buildNutrientFoodMap(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("every referenced biomarker resolves to a canonical biomarker", () => {
    const missing = nutrientFoodMapBiomarkers().filter(
      (n) => !CANONICAL_NAMES.has(n.toLowerCase())
    );
    expect(
      missing,
      `biomarker names in the map with no canonical-biomarkers.json entry: ${missing}`
    ).toEqual([]);
  });

  it("every referenced food–drug key exists in food-drug-interactions.json", () => {
    const missing = nutrientFoodMapDrugKeys().filter((k) => !DRUG_KEYS.has(k));
    expect(
      missing,
      `foodDrugKeys with no food-drug-interactions.json entry: ${missing}`
    ).toEqual([]);
  });

  it("every entry carries an evidence note, a source, and at least one food", () => {
    for (const e of buildNutrientFoodMap().entries) {
      expect(e.evidence.trim().length, e.key).toBeGreaterThan(0);
      expect(e.source.trim().length, e.key).toBeGreaterThan(0);
      expect(e.foods.length, e.key).toBeGreaterThan(0);
      expect(e.direction, e.key).toBe("low");
    }
  });
});
