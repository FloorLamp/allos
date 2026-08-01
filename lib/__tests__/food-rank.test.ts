import { describe, it, expect } from "vitest";
import {
  blendFoodOrder,
  demoteCappedGroups,
  isCappedFoodGroup,
} from "@/lib/food-rank";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";

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

// ---- Capped groups sort below floor groups (issue #1822 item 5) ----
//
// The reported defect: "🍷 Alcohol" took an above-the-fold quick-log button in the 08:00
// nudge, because ranking was usage-only with no awareness that alcohol is a CAPPED group
// ("less of this"). A positive-habits nudge was showing an encouragement-shaped affordance
// for the very thing being capped, ahead of the floor groups it exists to prompt. The
// button must not vanish — logging alcohol is exactly the tracking a cap needs — so this
// is a demotion, not a filter.

describe("demoteCappedGroups (#1822 item 5)", () => {
  it("knows which catalog groups are capped", () => {
    expect(isCappedFoodGroup("alcohol")).toBe(true);
    expect(isCappedFoodGroup("added_sugar")).toBe(true);
    expect(isCappedFoodGroup("fried_food")).toBe(true);
    // Floor groups — the ones the nudge exists to prompt.
    expect(isCappedFoodGroup("leafy_greens")).toBe(false);
    expect(isCappedFoodGroup("eggs")).toBe(false);
    // A non-catalog key (the reserved protein pseudo-group) and an unknown slug are
    // never capped — the refusal degrades to "keeps its earned rank".
    expect(isCappedFoodGroup(PROTEIN_NUDGE_KEY)).toBe(false);
    expect(isCappedFoodGroup("retired_group")).toBe(false);
  });

  it("puts a TOP-USAGE capped group below every floor group", () => {
    // Alcohol wins the blend outright and still lands last.
    const ranked = blendFoodOrder(
      ["leafy_greens", "alcohol", "berries"],
      [{ name: "alcohol", date: TODAY, weight: 20 }],
      [{ name: "alcohol", date: TODAY }],
      TODAY
    );
    expect(ranked[0]).toBe("alcohol");
    expect(demoteCappedGroups(ranked)).toEqual([
      "leafy_greens",
      "berries",
      "alcohol",
    ]);
  });

  it("DEMOTES, never filters — every key is still reachable", () => {
    const ranked = ["alcohol", "leafy_greens", "added_sugar", "berries"];
    const out = demoteCappedGroups(ranked);
    expect([...out].sort()).toEqual([...ranked].sort());
    expect(out).toEqual(["leafy_greens", "berries", "alcohol", "added_sugar"]);
  });

  it("is a STABLE partition — both sides keep their blended order", () => {
    const ranked = [
      "added_sugar",
      "berries",
      "alcohol",
      "leafy_greens",
      "fried_food",
    ];
    expect(demoteCappedGroups(ranked)).toEqual([
      "berries",
      "leafy_greens", // floor side, blend order preserved
      "added_sugar",
      "alcohol",
      "fried_food", // capped side, blend order preserved
    ]);
  });

  it("leaves the reserved protein pseudo-group where the blend put it", () => {
    expect(
      demoteCappedGroups(["alcohol", PROTEIN_NUDGE_KEY, "berries"])
    ).toEqual([PROTEIN_NUDGE_KEY, "berries", "alcohol"]);
  });

  it("changes nothing when no capped group is ranked", () => {
    const ranked = ["berries", "leafy_greens", "eggs"];
    expect(demoteCappedGroups(ranked)).toEqual(ranked);
    expect(demoteCappedGroups([])).toEqual([]);
  });
});
