import { describe, it, expect } from "vitest";
import { blendFoodOrder, proteinSplitIndex } from "@/lib/food-rank";

// Pure slot-aware blend (issue #950): slot frecency LEADS, overall frecency BACKFILLS,
// catalog order breaks the final tie. The degrade-to-overall property is the load-
// bearing invariant — a cold slot must reproduce today's ranking with no cliff.

const CATALOG = ["fatty_fish", "leafy_greens", "berries", "whole_grains"];
const TODAY = "2026-07-10";

describe("blendFoodOrder", () => {
  it("with NO slot signal, collapses to pure overall frecency (degrade property)", () => {
    const overall = [
      { name: "berries", date: TODAY, weight: 5 },
      { name: "leafy_greens", date: TODAY, weight: 2 },
    ];
    const ordered = blendFoodOrder(CATALOG, overall, [], TODAY);
    // berries (heaviest) then leafy_greens, then the untouched catalog tail.
    expect(ordered).toEqual([
      "berries",
      "leafy_greens",
      "fatty_fish",
      "whole_grains",
    ]);
  });

  it("an empty ledger yields the exact catalog order (fresh profile, no cliff)", () => {
    expect(blendFoodOrder(CATALOG, [], [], TODAY)).toEqual(CATALOG);
  });

  it("a group tapped in THIS slot leads, even over a heavier overall staple", () => {
    // whole_grains dominates overall; fatty_fish was tapped in the slot (lunch).
    const overall = [{ name: "whole_grains", date: TODAY, weight: 20 }];
    const slot = [{ name: "fatty_fish", date: TODAY }];
    const ordered = blendFoodOrder(CATALOG, overall, slot, TODAY);
    expect(ordered[0]).toBe("fatty_fish"); // slot leads
    expect(ordered[1]).toBe("whole_grains"); // overall backfills
  });

  it("among groups WITH slot signal, more slot taps rank higher", () => {
    const slot = [
      { name: "leafy_greens", date: TODAY },
      { name: "leafy_greens", date: TODAY },
      { name: "berries", date: TODAY },
    ];
    const ordered = blendFoodOrder(CATALOG, [], slot, TODAY);
    expect(ordered.indexOf("leafy_greens")).toBeLessThan(
      ordered.indexOf("berries")
    );
  });

  it("groups with no slot signal keep their OVERALL order among themselves", () => {
    // fatty_fish leads the slot; the rest carry only overall weight and must stay in
    // overall order (berries > whole_grains), not catalog order.
    const overall = [
      { name: "whole_grains", date: TODAY, weight: 1 },
      { name: "berries", date: TODAY, weight: 3 },
    ];
    const slot = [{ name: "fatty_fish", date: TODAY }];
    const ordered = blendFoodOrder(CATALOG, overall, slot, TODAY);
    expect(ordered).toEqual([
      "fatty_fish", // slot leader
      "berries", // heavier overall
      "whole_grains", // lighter overall
      "leafy_greens", // no signal → catalog tail
    ]);
  });

  it("recency decays a stale slot tap below a fresh one", () => {
    const slot = [
      { name: "berries", date: TODAY }, // fresh
      { name: "leafy_greens", date: "2026-04-01" }, // ~100 days stale
    ];
    const ordered = blendFoodOrder(CATALOG, [], slot, TODAY);
    expect(ordered.indexOf("berries")).toBeLessThan(
      ordered.indexOf("leafy_greens")
    );
  });
});

// ---- Ranking does not editorialize (#1980, reversing #1822 item 5) ----
//
// #1822 item 5 pushed CAPPED groups (the catalog's `limit` tier) below every floor group
// on the Telegram path. #1980 reversed it by owner ruling: a group you log often is one
// you need to log FAST, and position is a speed affordance, not a verdict. The pin below
// is the reversal — a heavily-logged capped group now LEADS, on frecency alone.

describe("capped groups rank on frecency alone (#1980 reversal pin)", () => {
  it("a heavily-logged capped group leads the order", () => {
    const ranked = blendFoodOrder(
      ["leafy_greens", "alcohol", "berries"],
      [{ name: "alcohol", date: TODAY, weight: 20 }],
      [{ name: "alcohol", date: TODAY }],
      TODAY
    );
    expect(ranked).toEqual(["alcohol", "leafy_greens", "berries"]);
  });

  it("the `limit` tier moves nothing — two groups with equal signal keep catalog order", () => {
    // added_sugar (limit) is curated ahead of berries here and stays ahead: the tier is
    // not consulted at all.
    const ranked = blendFoodOrder(
      ["added_sugar", "berries", "fried_food"],
      [],
      [],
      TODAY
    );
    expect(ranked).toEqual(["added_sugar", "berries", "fried_food"]);
  });

  it("the user's own exclusions are still the ONLY demotion (composed by the caller)", () => {
    // demoteExcludedGroups is exercised in dietary-preferences.test.ts; what matters here
    // is that the blend itself hands over an untouched frecency order for it to partition.
    const ranked = blendFoodOrder(
      ["leafy_greens", "alcohol"],
      [
        { name: "alcohol", date: TODAY, weight: 9 },
        { name: "leafy_greens", date: TODAY, weight: 1 },
      ],
      [],
      TODAY
    );
    expect(ranked[0]).toBe("alcohol");
  });
});

// ---- The protein control's slice point (#1980, fixed in #2061) ----
//
// The bar renders the protein entry as its own control between two slices of the quick
// rows. The rank it was given counts groups in the RANKED order; the rows it is sliced
// into are the quick set, which a deep link can reorder by pinning its own group to the
// front. These cases are that mismatch, in the shape the bar hits it.

describe("proteinSplitIndex (#2061)", () => {
  it("splits after the rows that outrank protein when the rendered order is the ranked one", () => {
    // Six quick rows drawn in rank order; protein ranked 4th overall, and two of those
    // four groups are in the quick set → the control renders after two rows.
    expect(proteinSplitIndex([0, 1, 5, 7, 9, 11], 4)).toBe(2);
  });

  it("renders the control first when every quick row is outranked by protein", () => {
    expect(proteinSplitIndex([3, 4, 8], 2)).toBe(0);
  });

  it("renders the control last when every quick row outranks protein", () => {
    expect(proteinSplitIndex([0, 1, 2], 9)).toBe(3);
  });

  it("a PINNED deep-link row that protein outranks puts the control above it", () => {
    // The bug: `fried_food` is pinned to the front by a "Log servings" deep link even
    // though it ranks 9th, and protein ranks 3rd. Counting the quick rows that outrank
    // protein gives 2 — which would leave the rank-1 and rank-2 rows BELOW the control
    // while the rank-9 pin sat above it. The scan answers 0: the first rendered row is
    // already one protein outranks, so the control leads.
    expect(proteinSplitIndex([9, 0, 1, 4, 6, 8], 3)).toBe(0);
  });

  it("a PINNED row that outranks protein keeps the control below it", () => {
    // Same pin, ranked ahead of protein this time: the pinned row stays above the
    // control, and the control still lands before the first row protein outranks.
    expect(proteinSplitIndex([1, 0, 2, 7, 9], 3)).toBe(3);
  });

  it("an untracked profile splits after every row, so the control renders last", () => {
    // proteinRank null = the entry was never ranked (#559: a cold start still gets the
    // control, it just goes at the end).
    expect(proteinSplitIndex([0, 1, 2], null)).toBe(3);
    expect(proteinSplitIndex([], null)).toBe(0);
  });

  it("a rank of 0 puts the control above everything", () => {
    expect(proteinSplitIndex([0, 1, 2], 0)).toBe(0);
  });
});
