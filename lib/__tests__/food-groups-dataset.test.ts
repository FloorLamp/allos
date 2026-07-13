import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFoodGroups } from "@/scripts/gen-food-groups";
import { FOOD_GROUPS, foodGroupSlugs } from "@/lib/food-groups";
import {
  nutrientFoodMapGroupSlugs,
  NUTRIENT_FOOD_ENTRIES,
} from "@/lib/food-suggest";

// Anti-drift pins for the curated food-group catalog (issue #579): the committed
// lib/food-groups.json is a FIXED POINT of the generator; slugs are unique, snake_case,
// and stable; and the CROSS-REFERENCES with the #577 nutrient-food-map hold in both
// directions — every foodGroup slug the map references resolves here, and every nutrient
// a group links resolves to a map entry. Pure — no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/food-groups.json");

const MAP_KEYS = new Set(NUTRIENT_FOOD_ENTRIES.map((e) => e.key));

describe("food-groups.json dataset", () => {
  it("is a fixed point of buildFoodGroups() (regenerate with `npm run gen:food-groups`)", () => {
    const generated = JSON.stringify(buildFoodGroups(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("has unique, snake_case slugs and a serving + tier per group", () => {
    const slugs = foodGroupSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const g of FOOD_GROUPS) {
      expect(g.slug, g.slug).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(g.serving.trim().length, g.slug).toBeGreaterThan(0);
      expect(["encourage", "limit", "neutral"], g.slug).toContain(g.tier);
    }
  });

  it("has a healthy number of groups (habit tier ~20–30)", () => {
    expect(FOOD_GROUPS.length).toBeGreaterThanOrEqual(20);
    expect(FOOD_GROUPS.length).toBeLessThanOrEqual(30);
  });

  // ── #577 ↔ #579 cross-reference (both directions) ──
  it("every food_group slug the #577 map references resolves to a group", () => {
    const groups = new Set(foodGroupSlugs());
    const missing = nutrientFoodMapGroupSlugs().filter((s) => !groups.has(s));
    expect(
      missing,
      `nutrient-food-map foodGroup slugs with no food group: ${missing}`
    ).toEqual([]);
  });

  it("every nutrient a group links resolves to a #577 map entry", () => {
    const bad: string[] = [];
    for (const g of FOOD_GROUPS)
      for (const n of g.nutrients)
        if (!MAP_KEYS.has(n)) bad.push(`${g.slug}→${n}`);
    expect(
      bad,
      `food-group nutrient links with no nutrient-food-map entry: ${bad}`
    ).toEqual([]);
  });
});
