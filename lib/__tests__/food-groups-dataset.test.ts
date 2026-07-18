import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFoodGroups } from "@/scripts/gen-food-groups";
import { FOOD_GROUPS, foodGroupSlugs } from "@/lib/food-groups";
import { foodGroupIconKey, GENERIC_FOOD_ICON_KEY } from "@/lib/food-group-icon";
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
const OUT = path.join(REPO, "lib/datasets/data/food-groups.json");

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

  // ── #767 protein grams: every protein-bearing slug resolves a positive number ──
  it("every protein-bearing group carries a positive protein_g, and non-bearing groups omit it", () => {
    // The catalog's protein-source groups — the estimate (#767) sums these as a floor.
    const BEARING = new Set([
      "fatty_fish",
      "lean_fish",
      "shellfish",
      "leafy_greens",
      "cruciferous",
      "other_vegetables",
      "legumes",
      "nuts_seeds",
      "whole_grains",
      "fermented",
      "poultry",
      "eggs",
      "dairy",
      "red_meat",
      "tubers",
      "processed_meat",
      "refined_grains",
    ]);
    for (const g of FOOD_GROUPS) {
      if (BEARING.has(g.slug)) {
        expect(typeof g.protein_g, g.slug).toBe("number");
        expect(g.protein_g, g.slug).toBeGreaterThan(0);
      } else {
        // Non-protein groups (fruit, water, sweets, alcohol) deliberately omit it.
        expect(g.protein_g, g.slug).toBeUndefined();
      }
    }
  });

  // ── #824 one-mechanism rule: NO protein-shake/powder catalog entry ──
  it("has no food-group entry representing protein powder / shakes (the one-mechanism rule)", () => {
    // Protein powder is deliberately NOT a food group (#824): a `protein_shake` catalog
    // entry would double-count once someone also logs the milk/eggs in the shake. Its
    // ONLY home is the protein-grams quick-add (protein_log), which SUMS with the
    // food-group estimate. The whole-foods catalog must stay whole-foods — guard that no
    // slug or name ever grows into a supplement/shake bucket.
    const BANNED =
      /shake|protein[\s_-]*powder|whey|casein|protein[\s_-]*supplement/i;
    const offenders = FOOD_GROUPS.filter(
      (g) => BANNED.test(g.slug) || BANNED.test(g.name)
    ).map((g) => g.slug);
    expect(
      offenders,
      `food groups representing protein powder/shakes (rejected by #824 — use the protein-grams quick-add): ${offenders}`
    ).toEqual([]);
  });

  // ── #591 icon coverage (reflection guard) ──
  it("every catalog slug resolves to a real (non-generic) food-group icon key", () => {
    // The generic fallback is only for retired/unknown slugs — every CURRENT
    // catalog group must have a curated icon, so the log bar / rollup / habits /
    // suggestion buttons never fall back to the plate-of-cutlery glyph.
    const generic = FOOD_GROUPS.filter(
      (g) => foodGroupIconKey(g.slug) === GENERIC_FOOD_ICON_KEY
    ).map((g) => g.slug);
    expect(
      generic,
      `food groups with no curated icon (falls back to generic): ${generic}`
    ).toEqual([]);
  });

  it("resolves an unknown slug to the generic glyph rather than throwing (#203)", () => {
    expect(foodGroupIconKey("__retired_slug__")).toBe(GENERIC_FOOD_ICON_KEY);
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
