import { describe, it, expect } from "vitest";
import {
  expandPreset,
  presetForExcluded,
  normalizeExcludedGroups,
  applyPreferenceFilter,
  demoteExcludedGroups,
  isExcludedGroup,
  preferenceSuggestionNote,
  DIETARY_PRESETS,
} from "@/lib/dietary-preferences";
import { foodGroupSlugs } from "@/lib/food-groups";

// Pure-tier tests for dietary preferences (issue #975): preset→set expansion (each pinned),
// the derived preset label, the substitution rule, and the ranking demotion.

describe("preset → excluded-set expansion (the decided table)", () => {
  it("pins each preset's exact excluded slug set", () => {
    expect(expandPreset("omnivore")).toEqual([]);
    expect(expandPreset("vegetarian")).toEqual(
      [
        "fatty_fish",
        "lean_fish",
        "shellfish",
        "poultry",
        "red_meat",
        "processed_meat",
      ].sort()
    );
    expect(expandPreset("vegan")).toEqual(
      [
        "fatty_fish",
        "lean_fish",
        "shellfish",
        "poultry",
        "red_meat",
        "processed_meat",
        "eggs",
        "dairy",
      ].sort()
    );
    expect(expandPreset("pescatarian")).toEqual(
      ["poultry", "red_meat", "processed_meat"].sort()
    );
    expect(expandPreset("no_red_meat")).toEqual(
      ["red_meat", "processed_meat"].sort()
    );
    expect(expandPreset("dairy_free")).toEqual(["dairy"]);
    expect(expandPreset("keto")).toEqual(
      [
        "whole_grains",
        "refined_grains",
        "tubers",
        "legumes",
        "fruit",
        "added_sugar",
        "sugary_drinks",
      ].sort()
    );
  });

  it("keto deliberately KEEPS berries (the low-carb nutrient allowance)", () => {
    expect(expandPreset("keto")).not.toContain("berries");
  });

  it("every preset's slugs are real catalog groups", () => {
    const catalog = new Set(foodGroupSlugs());
    for (const preset of DIETARY_PRESETS) {
      for (const slug of expandPreset(preset)) {
        expect(catalog.has(slug), `${preset}:${slug}`).toBe(true);
      }
    }
  });
});

describe("presetForExcluded (derived label, drops to custom on divergence)", () => {
  it("recovers the preset name from its exact set", () => {
    for (const preset of DIETARY_PRESETS) {
      expect(presetForExcluded(expandPreset(preset))).toBe(preset);
    }
  });

  it("an empty set is Omnivore", () => {
    expect(presetForExcluded([])).toBe("omnivore");
  });

  it("a diverged set is custom", () => {
    // Vegetarian minus one item — no longer any preset.
    const diverged = expandPreset("vegetarian").filter(
      (s) => s !== "shellfish"
    );
    expect(presetForExcluded(diverged)).toBe("custom");
    // Vegetarian plus a dislike — also custom.
    expect(presetForExcluded([...expandPreset("vegetarian"), "alcohol"])).toBe(
      "custom"
    );
  });

  it("order-independent (a shuffled set still matches its preset)", () => {
    expect(presetForExcluded([...expandPreset("vegan")].reverse())).toBe(
      "vegan"
    );
  });
});

describe("normalizeExcludedGroups", () => {
  it("canonicalizes, de-dupes, sorts, and drops unknown slugs", () => {
    expect(
      normalizeExcludedGroups(["dairy", "dairy", "not_a_group", "eggs"])
    ).toEqual(["dairy", "eggs"]);
  });
});

describe("applyPreferenceFilter (substitute, never an empty suggestion)", () => {
  const zincFoods = [
    { food: "Oysters", foodGroup: "shellfish" },
    { food: "Beef", foodGroup: "red_meat" },
    { food: "Legumes", foodGroup: "legumes" },
    { food: "Pumpkin seeds", foodGroup: "nuts_seeds" },
  ];

  it("drops excluded groups and leads with the compatible source", () => {
    const excluded = new Set(["shellfish", "red_meat"]); // vegetarian-ish
    const out = applyPreferenceFilter(zincFoods, excluded);
    expect(out.map((f) => f.foodGroup)).toEqual(["legumes", "nuts_seeds"]);
  });

  it("keeps ALL sources when every one is excluded (shortfall never disappears)", () => {
    const excluded = new Set([
      "shellfish",
      "red_meat",
      "legumes",
      "nuts_seeds",
    ]);
    const out = applyPreferenceFilter(zincFoods, excluded);
    expect(out).toHaveLength(zincFoods.length);
  });

  it("a null foodGroup is never excluded", () => {
    const foods = [{ food: "Something untracked", foodGroup: null }];
    expect(applyPreferenceFilter(foods, new Set(["dairy"]))).toHaveLength(1);
    expect(isExcludedGroup(null, new Set(["dairy"]))).toBe(false);
  });

  it("no exclusions is a passthrough", () => {
    expect(applyPreferenceFilter(zincFoods, new Set())).toEqual(zincFoods);
  });
});

describe("demoteExcludedGroups (composes with slot frecency; keeps reachable)", () => {
  it("moves excluded slugs to the tail, preserving the ranked order of the rest", () => {
    const ranked = ["poultry", "legumes", "red_meat", "leafy_greens", "eggs"];
    const excluded = new Set(["poultry", "red_meat", "eggs"]); // pescatarian-ish
    const out = demoteExcludedGroups(ranked, excluded);
    // Non-excluded keep frecency order, excluded appended in original order.
    expect(out).toEqual([
      "legumes",
      "leafy_greens",
      "poultry",
      "red_meat",
      "eggs",
    ]);
    // Every group still present (reachable) — demotion never drops.
    expect(new Set(out)).toEqual(new Set(ranked));
  });

  it("no exclusions is a passthrough", () => {
    const ranked = ["a", "b", "c"];
    expect(demoteExcludedGroups(ranked, new Set())).toEqual(ranked);
  });
});

describe("preferenceSuggestionNote (#980 legibility)", () => {
  it("an unset preference renders no note (no empty chrome)", () => {
    expect(preferenceSuggestionNote([])).toBeNull();
  });

  it("a named preset names the pattern in the note", () => {
    expect(preferenceSuggestionNote(expandPreset("vegetarian"))).toBe(
      "showing vegetarian-friendly sources"
    );
    expect(preferenceSuggestionNote(expandPreset("vegan"))).toBe(
      "showing vegan-friendly sources"
    );
    expect(preferenceSuggestionNote(expandPreset("pescatarian"))).toBe(
      "showing pescatarian-friendly sources"
    );
    expect(preferenceSuggestionNote(expandPreset("keto"))).toBe(
      "showing keto-friendly sources"
    );
    // The two presets that read awkwardly with "-friendly" state the exclusion instead.
    expect(preferenceSuggestionNote(expandPreset("dairy_free"))).toBe(
      "showing dairy-free sources"
    );
    expect(preferenceSuggestionNote(expandPreset("no_red_meat"))).toBe(
      "showing sources without red meat"
    );
  });

  it("a custom set (matching no named preset) gets the neutral note", () => {
    // dairy + fruit matches no preset → custom.
    expect(preferenceSuggestionNote(["dairy", "fruit"])).toBe(
      "showing sources that fit your preferences"
    );
  });

  it("normalizes the input (unknown slugs dropped, order-independent)", () => {
    expect(preferenceSuggestionNote([...expandPreset("vegan")].reverse())).toBe(
      "showing vegan-friendly sources"
    );
    // Only junk → nothing real excluded → no note.
    expect(preferenceSuggestionNote(["not_a_group"])).toBeNull();
  });
});
