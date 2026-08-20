// The product-fact exchange between a shared bottle and an intake item (#1705).
// Pure: the two seed directions, the no-clobber prefill rule, the one shared label,
// and which surface an item created from a bottle lands on.

import { describe, it, expect } from "vitest";
import {
  itemStrength,
  poolSeedFromItem,
  itemSeedFromPool,
  applyProductSeed,
  productLabel,
  bottleLabel,
  poolSurfaceKind,
  bottleFitsKindDoor,
  bottleSiblingKind,
} from "../supply-product";
import type { IntakeItemKind } from "../types/intake";

describe("itemStrength", () => {
  it("takes the first non-empty active dose amount", () => {
    expect(
      itemStrength({ name: "D3", doseAmounts: ["5000 IU", "1000 IU"] })
    ).toBe("5000 IU");
  });

  it("skips blank amounts rather than reporting an empty strength", () => {
    expect(
      itemStrength({ name: "D3", doseAmounts: ["", "  ", "400 IU"] })
    ).toBe("400 IU");
  });

  it("is null when the item records no amount at all", () => {
    expect(itemStrength({ name: "D3", doseAmounts: [] })).toBe(null);
  });
});

describe("poolSeedFromItem — direction 1", () => {
  it("carries the item's name and strength into the new bottle", () => {
    expect(
      poolSeedFromItem({ name: "  Cholecalciferol ", doseAmounts: ["5000 IU"] })
    ).toEqual({ name: "Cholecalciferol", strength: "5000 IU" });
  });

  it("leaves strength null when the item never recorded one", () => {
    expect(poolSeedFromItem({ name: "Magnesium", doseAmounts: [] })).toEqual({
      name: "Magnesium",
      strength: null,
    });
  });
});

describe("itemSeedFromPool — direction 2", () => {
  it("prefills the item's name and first dose amount from the bottle", () => {
    expect(
      itemSeedFromPool({
        name: "Vitamin D3",
        strength: "5000 IU",
        form: "capsule",
      })
    ).toEqual({ name: "Vitamin D3", amount: "5000 IU" });
  });

  it("prefills an empty amount when the bottle carries no strength", () => {
    expect(
      itemSeedFromPool({ name: "Vitamin D3", strength: null, form: "capsule" })
    ).toEqual({ name: "Vitamin D3", amount: "" });
  });
});

describe("applyProductSeed", () => {
  it("fills an empty field", () => {
    expect(applyProductSeed("", null, "5000 IU")).toBe("5000 IU");
  });

  it("corrects the value a previous pick put there", () => {
    expect(applyProductSeed("5000 IU", "5000 IU", "1000 IU")).toBe("1000 IU");
  });

  it("never overwrites what the user typed", () => {
    expect(applyProductSeed("half a capsule", "5000 IU", "1000 IU")).toBe(
      "half a capsule"
    );
  });

  it("clears back to empty when the bottle is deselected", () => {
    expect(applyProductSeed("5000 IU", "5000 IU", "")).toBe("");
  });
});

describe("productLabel / bottleLabel", () => {
  it("joins strength and form", () => {
    expect(productLabel({ strength: "5000 IU", form: "capsule" })).toBe(
      "5000 IU · capsule"
    );
  });

  it("keeps whichever fact the bottle actually carries", () => {
    expect(productLabel({ strength: null, form: "tablet" })).toBe("tablet");
    expect(productLabel({ strength: "200 mg", form: null })).toBe("200 mg");
  });

  it("is null when the bottle carries neither", () => {
    expect(productLabel({ strength: null, form: "  " })).toBe(null);
  });

  it("renders a bottle with no product facts as just its name", () => {
    expect(bottleLabel({ name: "Ibuprofen", strength: null, form: null })).toBe(
      "Ibuprofen"
    );
    expect(
      bottleLabel({ name: "Ibuprofen", strength: "200 mg", form: "tablet" })
    ).toBe("Ibuprofen (200 mg · tablet)");
  });
});

describe("poolSurfaceKind", () => {
  it("sends a bottle with a medication member to the medications surface", () => {
    expect(
      poolSurfaceKind([{ kind: "supplement" }, { kind: "medication" }])
    ).toBe("medication");
  });

  it("sends a supplement-only bottle to the supplements surface", () => {
    expect(poolSurfaceKind([{ kind: "supplement" }])).toBe("supplement");
  });

  it("defaults an orphaned bottle to the supplements surface", () => {
    expect(poolSurfaceKind([])).toBe("supplement");
  });
});

// #3270 — WHICH BOTTLES A DOOR OFFERS, as a closed matrix rather than as a row of
// example labels. The bug was an UNFILTERED list that rendered perfectly plausibly, so
// every assertion available at the rendering level ("the list is non-empty", "the row
// reads Ibuprofen — shared bottle") passed under it and discriminated nothing. The
// question that discriminates is the pairing: for each door, each bottle kind, offered
// or not. Enumerated exhaustively so no cell can be added, dropped or flipped without
// this failing — including the two `true` cells the fix does NOT change, which are what
// keeps an over-eager filter from quietly emptying the unlocked door.
describe("bottleFitsKindDoor — the door × bottle-kind matrix", () => {
  const doors: (IntakeItemKind | null)[] = [null, "medication", "supplement"];
  const siblings: (IntakeItemKind | null)[] = [
    null,
    "medication",
    "supplement",
  ];

  // door → sibling kind → offered. `null` sibling = a bottle nothing links yet.
  const expected: Record<string, Record<string, boolean>> = {
    // An unlocked door derives the kind from the pick and can be corrected, so it
    // offers every bottle — unchanged by #3270.
    none: { none: true, medication: true, supplement: true },
    medication: { none: true, medication: true, supplement: false },
    supplement: { none: true, medication: false, supplement: true },
  };

  const key = (kind: IntakeItemKind | null) => kind ?? "none";

  for (const door of doors) {
    for (const sibling of siblings) {
      const want = expected[key(door)][key(sibling)];
      it(`${key(door)} door ${want ? "offers" : "withholds"} a ${key(sibling)} bottle`, () => {
        expect(bottleFitsKindDoor({ siblingKind: sibling }, door)).toBe(want);
      });
    }
  }

  // A bottle whose option was built before siblingKind existed carries no such field
  // at all. Absent must read as "no sibling", not as a contradiction — otherwise the
  // locked doors silently empty.
  it("treats an absent siblingKind the same as a null one", () => {
    expect(bottleFitsKindDoor({}, "supplement")).toBe(true);
    expect(bottleFitsKindDoor({}, "medication")).toBe(true);
  });

  // The two facts the matrix rests on, asserted where they are used rather than
  // assumed: what a bottle's own membership lends is exactly what the door compares
  // against, and a mixed bottle leans medication (poolSurfaceKind's safety direction),
  // so it is withheld from the supplement door.
  it("reads a mixed-membership bottle as a medication and withholds it from Add supplement", () => {
    const mixed = {
      siblingKind: bottleSiblingKind([
        { kind: "supplement" },
        { kind: "medication" },
      ]),
    };
    expect(mixed.siblingKind).toBe("medication");
    expect(bottleFitsKindDoor(mixed, "supplement")).toBe(false);
    expect(bottleFitsKindDoor(mixed, "medication")).toBe(true);
  });

  it("offers a bottle nobody links yet in both locked doors", () => {
    const unlinked = { siblingKind: bottleSiblingKind([]) };
    expect(unlinked.siblingKind).toBe(null);
    expect(bottleFitsKindDoor(unlinked, "supplement")).toBe(true);
    expect(bottleFitsKindDoor(unlinked, "medication")).toBe(true);
  });
});
