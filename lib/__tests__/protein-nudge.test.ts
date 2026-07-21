// PURE TIER — the reserved __protein__ pseudo-group (issue #1073). Two things are pinned:
// (1) the RESERVED-KEY DISCIPLINE — __protein__ is a ranking participant ONLY and is
// excluded from every food-GROUP code path (catalog resolution, canonicalization, dietary
// demotion); (2) it ranks by SLOT frecency among real food slugs through the SAME
// blendFoodOrder the food groups use (evening taps ⇒ high on the evening keyboard, absent
// at breakfast), so it self-surfaces where the profile actually logs protein.

import { describe, it, expect } from "vitest";
import {
  PROTEIN_NUDGE_KEY,
  isProteinNudgeKey,
  proteinNudgeButtonLabel,
  DEFAULT_PROTEIN_PRESET_GRAMS,
} from "@/lib/protein-nudge";
import {
  foodGroupSlugs,
  foodGroupBySlug,
  isValidFoodGroup,
  canonicalFoodGroup,
} from "@/lib/food-groups";
import { blendFoodOrder } from "@/lib/food-rank";
import { demoteExcludedGroups } from "@/lib/dietary-preferences";

const TODAY = "2026-07-13";

describe("reserved-key discipline (#1073)", () => {
  it("is NOT a catalog food group (excluded from FOOD_GROUPS/foodGroupSlugs)", () => {
    expect(foodGroupSlugs()).not.toContain(PROTEIN_NUDGE_KEY);
    expect(foodGroupBySlug(PROTEIN_NUDGE_KEY)).toBeUndefined();
    expect(isValidFoodGroup(PROTEIN_NUDGE_KEY)).toBe(false);
  });

  it("does not canonicalize to a food group (a forged food-log token lands nothing)", () => {
    // canonicalFoodGroup is the gate logFoodServingCore runs — null means the serving
    // write refuses, so the reserved key can never become a food_log serving.
    expect(canonicalFoodGroup(PROTEIN_NUDGE_KEY)).toBeNull();
  });

  it("is recognized by isProteinNudgeKey and nothing else", () => {
    expect(isProteinNudgeKey(PROTEIN_NUDGE_KEY)).toBe(true);
    expect(isProteinNudgeKey("leafy_greens")).toBe(false);
    expect(isProteinNudgeKey("protein")).toBe(false);
  });

  it("labels the button with the grams preset", () => {
    expect(proteinNudgeButtonLabel(30)).toBe("＋30g protein");
    expect(proteinNudgeButtonLabel(DEFAULT_PROTEIN_PRESET_GRAMS)).toBe(
      "＋30g protein"
    );
  });

  it("is EXEMPT from dietary-exclusion demotion (#975) — it's not a food group", () => {
    // Excluding a real group demotes only that group; __protein__ keeps its ranked spot.
    const ranked = ["fatty_fish", PROTEIN_NUDGE_KEY, "red_meat", "berries"];
    const out = demoteExcludedGroups(ranked, new Set(["red_meat"]));
    expect(out).toEqual([
      "fatty_fish",
      PROTEIN_NUDGE_KEY,
      "berries",
      "red_meat",
    ]);
  });
});

describe("__protein__ ranks by slot frecency among food slugs (#1073)", () => {
  // A curated list with __protein__ inserted mid-list (mirrors proteinNudgeCurated), so at
  // cold start it sorts mid-list, and with slot signal it leads.
  const CURATED = [
    "whole_grains",
    "leafy_greens",
    PROTEIN_NUDGE_KEY,
    "berries",
    "fatty_fish",
  ];

  it("with EVENING __protein__ taps, the key climbs to the front of the evening keyboard", () => {
    const slot = [
      { name: PROTEIN_NUDGE_KEY, date: TODAY },
      { name: PROTEIN_NUDGE_KEY, date: TODAY },
    ];
    const ordered = blendFoodOrder(CURATED, [], slot, TODAY);
    expect(ordered[0]).toBe(PROTEIN_NUDGE_KEY); // slot leader
  });

  it("with NO __protein__ signal (breakfast), it sinks below groups that HAVE signal", () => {
    // whole_grains + leafy_greens carry breakfast signal; __protein__ carries none, so it
    // ranks after them (mid-list catalog fallback), off the top-2.
    const slot = [
      { name: "whole_grains", date: TODAY },
      { name: "leafy_greens", date: TODAY },
    ];
    const ordered = blendFoodOrder(CURATED, [], slot, TODAY);
    expect(ordered.slice(0, 2)).toEqual(["whole_grains", "leafy_greens"]);
    expect(ordered.indexOf(PROTEIN_NUDGE_KEY)).toBeGreaterThan(1);
  });
});
