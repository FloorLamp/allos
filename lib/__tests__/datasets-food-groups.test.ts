import { describe, expect, it } from "vitest";
import {
  foodGroupsDataset,
  foodGroupBySlug,
  canonicalFoodGroup,
  FOOD_GROUPS,
  FOOD_GROUP_EMOJI,
  FOOD_GROUP_SHORT,
  foodGroupEmoji,
  foodGroupShortName,
} from "@/lib/datasets/food-groups";
import { foodGroupIconKey } from "@/lib/food-group-icon";
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

// ---- One emoji per group (issue #1710) ----
//
// The glyphs are what make the Telegram button grid and the tally scannable, and the web
// food bar reads the SAME catalog — so a missing or duplicated glyph is a cross-surface
// vocabulary bug, not a cosmetic one.
describe("food-group emoji catalog (#1710)", () => {
  it("covers every catalog group exactly once", () => {
    const slugs = FOOD_GROUPS.map((g) => g.slug).sort();
    expect(Object.keys(FOOD_GROUP_EMOJI).sort()).toEqual(slugs);
    for (const slug of slugs) expect(foodGroupEmoji(slug)).not.toBe("");
  });

  it("gives no two groups the same glyph", () => {
    const glyphs = Object.values(FOOD_GROUP_EMOJI);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("degrades to no emoji for a retired/unknown slug", () => {
    expect(foodGroupEmoji("not_a_group")).toBe("");
  });

  it("short names cover every catalog group, stay short, and never collide", () => {
    const slugs = FOOD_GROUPS.map((g) => g.slug).sort();
    expect(Object.keys(FOOD_GROUP_SHORT).sort()).toEqual(slugs);
    const shorts = Object.values(FOOD_GROUP_SHORT);
    expect(new Set(shorts).size).toBe(shorts.length);
    // "Short" is the contract: nothing longer than the chip budget.
    for (const s of shorts) expect(s.length).toBeLessThanOrEqual(14);
    // The distinguishing word survives abbreviation: the two fish groups
    // must not collapse to one chip label.
    expect(foodGroupShortName("fatty_fish")).not.toBe(
      foodGroupShortName("lean_fish")
    );
  });

  it("short name falls back to the full name, then the slug, for unknowns", () => {
    expect(foodGroupShortName("not_a_group")).toBe("not_a_group");
  });

  // The web food surfaces render Tabler SVG icons per group (lib/food-group-icon.ts) —
  // a richer glyph system than emoji, and adding emoji there would double-mark every
  // row. So the two vocabularies are not merged; what IS pinned is that they cover the
  // catalog identically, so a group can never be glyphed on one surface and bare on the
  // other.
  it("covers exactly the groups the web icon map covers", () => {
    for (const g of FOOD_GROUPS) {
      expect(foodGroupEmoji(g.slug)).not.toBe("");
      expect(foodGroupIconKey(g.slug)).toBeTruthy();
    }
  });
});
