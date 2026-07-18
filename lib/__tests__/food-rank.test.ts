import { describe, it, expect } from "vitest";
import { blendFoodOrder } from "@/lib/food-rank";

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
