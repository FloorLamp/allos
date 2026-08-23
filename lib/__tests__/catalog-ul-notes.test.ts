import { describe, it, expect } from "vitest";
import {
  SUPPLEMENT_CATALOG,
  type SupplementCatalogEntry,
} from "../supplement-catalog";
import {
  catalogUlExceedances,
  catalogEntryByName,
  formulationUlNote,
} from "../supplement-catalog-ul";
import {
  stackUlWarnings,
  ulWarningDetail,
  type StackItem,
  type NutrientContribution,
} from "../dri";
import { normalizeIngredientDrafts } from "../intake-ingredients";
import { driNutrientForKey } from "../datasets/dri";

// Issue #3156 ruling 2 — the AREDS 2 upper-limit reason.
//
// Seed a product, take it as its own label directs, and the app warns about the
// product it just prefilled. The owner ruling keeps that warning (AREDS 2 really is
// above the zinc UL, by design) and requires it to SAY SO, because a generic
// exceedance on the app's own seeded serving reads like a bug — and "looks like a bug"
// is how a real warning gets ignored.
//
// The reason used to live in a source comment on the catalog entry, readable by
// whoever opened lib/supplement-catalog.ts and by nobody else. These are the guards
// that keep it on the screen and keep it TRUE.

// Build the stack item the app would build for a catalogued product taken at one of
// its own stated servings. Mirrors lib/supplement-catalog-ul's census input.
function itemFor(entry: SupplementCatalogEntry, dose: string): StackItem {
  const parsed = normalizeIngredientDrafts(
    (entry.ingredients ?? []).map((i) => ({
      name: i.name,
      amount_text: i.amount ?? "",
    }))
  );
  if (!parsed.ok) throw new Error(`unreadable label amount on ${entry.name}`);
  return {
    name: entry.name,
    active: true,
    doseAmounts: [dose],
    ingredients: parsed.rows.map((r) => ({
      name: r.name,
      amount: r.amount,
      unit: r.unit,
    })),
  };
}

describe("catalog UL reasons — the shipped catalog", () => {
  it("declares a reason for every product that trips a UL at its own stated serving", () => {
    // THE GUARD. It is a computed reverse-lookup, not a list: seed a new blend that
    // happens to exceed a limit, or change an existing one's amounts, and this fails
    // until somebody writes the sentence a person will read.
    const undeclared = catalogUlExceedances().filter((x) => {
      const entry = catalogEntryByName(x.name);
      return !entry?.aboveUpperLimit?.some((n) => n.nutrient === x.nutrient);
    });
    expect(undeclared).toEqual([]);
  });

  it("names AREDS 2's zinc as the one shipped exceedance", () => {
    // Pinned so the guard above cannot pass by finding nothing. Measured over the
    // shipped catalog: exactly one product, one nutrient, one serving.
    expect(catalogUlExceedances()).toEqual([
      {
        name: "PreserVision AREDS 2",
        dose: "2 softgels",
        nutrient: "zinc",
        total: 80,
        ul: 40,
        unit: "mg",
      },
    ]);
  });

  it("stays silent on the blends that sit under every limit", () => {
    // The benign neighbours. A guard that also fired on AG1, LMNT or Emergen-C would
    // be deleted within a week, taking the real guard with it.
    const tripped = new Set(catalogUlExceedances().map((x) => x.name));
    for (const name of ["AG1", "LMNT", "Emergen-C"]) {
      const entry = catalogEntryByName(name);
      expect(entry?.ingredients?.length).toBeGreaterThan(0);
      expect(tripped.has(name)).toBe(false);
      expect(entry?.aboveUpperLimit).toBeUndefined();
    }
  });

  it("every declared reason names a nutrient its product actually exceeds", () => {
    // The other direction: a declaration must not outlive the exceedance it explains.
    // Reformulate an entry down under its limit and the sentence becomes false —
    // this fails rather than leaving the app asserting something untrue.
    const exceeded = new Set(
      catalogUlExceedances().map((x) => `${x.name} ${x.nutrient}`)
    );
    const stale: string[] = [];
    for (const entry of SUPPLEMENT_CATALOG) {
      for (const note of entry.aboveUpperLimit ?? []) {
        if (!exceeded.has(`${entry.name} ${note.nutrient}`)) {
          stale.push(`${entry.name} / ${note.nutrient}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("every declared reason names a real DRI nutrient key", () => {
    for (const entry of SUPPLEMENT_CATALOG) {
      for (const note of entry.aboveUpperLimit ?? []) {
        expect(driNutrientForKey(note.nutrient)).not.toBeNull();
        expect(note.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("catalog UL reasons — what a person reads", () => {
  const areds = catalogEntryByName("PreserVision AREDS 2")!;

  // A hand-built warning, for the cases that are about the JOIN rather than about the
  // stack arithmetic. The total and the limit are stated because the note now depends
  // on them: the same contributor list reads differently at a different total.
  function note(
    key: string,
    total: number,
    ul: number,
    contributors: NutrientContribution[]
  ) {
    return formulationUlNote({ key, total, ul, contributors });
  }

  // A plain second zinc source, so a stack can be over the limit without AREDS 2.
  function zincItem(mg: number, name = "Zinc Picolinate"): StackItem {
    return {
      name,
      active: true,
      doseAmounts: ["1 capsule"],
      ingredients: [{ name: "Zinc", amount: mg, unit: "mg" }],
    };
  }

  // The zinc warning a real adult stack raises, through the real engine.
  function zincWarning(items: StackItem[]) {
    const w = stackUlWarnings(items, 40, "male").find((x) => x.key === "zinc");
    if (!w) throw new Error("expected a zinc UL warning for this stack");
    return w;
  }

  it("puts the reason in the zinc warning AREDS 2 raises on its own serving", () => {
    const [warning] = stackUlWarnings(
      [itemFor(areds, "2 softgels")],
      40,
      "male"
    );
    expect(warning.key).toBe("zinc");
    const note = formulationUlNote(warning);
    expect(note).toBe(
      "PreserVision AREDS 2 is above the general zinc limit by design: it matches " +
        "the AREDS2 eye-health formula. The total is expected for this product."
    );
    const detail = ulWarningDetail(warning, null, note);
    expect(detail).toContain("by design");
    expect(detail).toContain("AREDS2 eye-health formula");
    // The warning is EXPLAINED, never softened: same total, same limit, same close.
    expect(detail).toContain("80 mg");
    expect(detail).toContain("40 mg");
    expect(detail).toContain(
      "Discuss with your clinician before changing anything."
    );
    // And the reason comes BEFORE that close, so it reframes the line rather than
    // trailing after it.
    expect(detail.indexOf("by design")).toBeLessThan(
      detail.indexOf("Discuss with your clinician")
    );
  });

  it("says nothing when the same product is taken at a serving that stays under", () => {
    expect(stackUlWarnings([itemFor(areds, "1 softgel")], 40, "male")).toEqual(
      []
    );
  });

  it("attaches the note to the nutrient it explains and to no other", () => {
    const contributors: NutrientContribution[] = [
      { name: "PreserVision AREDS 2", amount: 80 },
    ];
    expect(note("zinc", 80, 40, contributors)).toContain("by design");
    expect(note("copper", 80, 10, contributors)).toBeNull();
    expect(note("vitamin_e", 80, 1000, contributors)).toBeNull();
  });

  it("says nothing when another product is what pushed the total over", () => {
    // THE CAUSATION GUARD. AREDS 2 at ONE softgel is 40 mg — exactly at the adult UL
    // and over nothing on its own. Add a separate 50 mg zinc and the stack is at 90
    // mg, 2.25x the limit, because of the OTHER bottle. The declared reason ends "The
    // total is expected for this product", and a total this product does not explain
    // must never carry it: a person told a warning is expected stops reading it, which
    // is the exact failure #3156's ruling exists to prevent, pointed the other way.
    const warning = zincWarning([itemFor(areds, "1 softgel"), zincItem(50)]);
    expect(warning.total).toBe(90);
    expect(warning.ul).toBe(40);
    expect(formulationUlNote(warning)).toBeNull();
    const detail = ulWarningDetail(warning, null, formulationUlNote(warning));
    expect(detail).not.toContain("expected for this product");
    expect(detail).not.toContain("by design");
    // Suppressed, never softened: the number, the limit and the close are untouched.
    expect(detail).toContain("90 mg");
    expect(detail).toContain("40 mg");
    expect(detail).toContain(
      "Discuss with your clinician before changing anything."
    );
  });

  it("still says nothing when BOTH sources are over the limit alone", () => {
    // AREDS 2 at its own 2-softgel serving (80 mg) really is above the limit by
    // design — but at 130 mg the total is not this product's, and the other bottle
    // would have raised the warning by itself. Neither product explains this line.
    const warning = zincWarning([itemFor(areds, "2 softgels"), zincItem(50)]);
    expect(warning.total).toBe(130);
    expect(formulationUlNote(warning)).toBeNull();
  });

  it("still says nothing when three sources share an exceedance nobody caused", () => {
    // 40 + 10 + 5 = 55. Removing AREDS 2 drops the stack under the limit, so it is
    // NECESSARY — but its own one-softgel 40 mg is not above the limit, so "above the
    // general zinc limit by design" is not true of what this person takes. Necessity
    // alone is not enough; the product's own serving has to be the thing over.
    const warning = zincWarning([
      itemFor(areds, "1 softgel"),
      zincItem(10, "Zinc Gluconate"),
      zincItem(5, "Multivitamin"),
    ]);
    expect(warning.total).toBe(55);
    expect(formulationUlNote(warning)).toBeNull();
  });

  it("keeps the note when the product is over alone and the rest is not", () => {
    // The other side of the boundary, so the guard above cannot pass by suppressing
    // everything: AREDS 2 at 80 mg beside a small multivitamin. The 8 mg raises no
    // warning on its own, so this exceedance is still the product's and still explained.
    const warning = zincWarning([
      itemFor(areds, "2 softgels"),
      zincItem(8, "Multivitamin"),
    ]);
    expect(warning.total).toBe(88);
    expect(formulationUlNote(warning)).toContain("by design");
  });

  it("says nothing for a product that is not the catalogued one", () => {
    // EXACT name match. A renamed or look-alike item gets the ordinary generic
    // warning — nobody here knows what is in that bottle.
    for (const name of ["AREDS 2", "PreserVision AREDS 2 Generic", "Zinc"]) {
      expect(note("zinc", 80, 40, [{ name, amount: 80 }])).toBeNull();
    }
    // Case and surrounding space are not part of the identity, matching the form's
    // own catalog lookup.
    expect(
      note("zinc", 80, 40, [{ name: "  preservision areds 2 ", amount: 80 }])
    ).toContain("by design");
  });

  it("leaves the detail line unchanged when there is no note", () => {
    const [warning] = stackUlWarnings(
      [itemFor(areds, "2 softgels")],
      40,
      "male"
    );
    expect(ulWarningDetail(warning, null, null)).toBe(
      ulWarningDetail(warning, null)
    );
  });
});

describe("catalog UL reasons — the guard can see", () => {
  // A green sweep over a COMPLYING catalog says nothing about what the sweep can see.
  // These run the same census over catalogs authored to break it.
  const overLimit = [
    { name: "Zinc", amount: "50 mg" },
    { name: "Copper", amount: "1 mg" },
  ];

  it("finds an undeclared exceedance in a catalog that omits the reason", () => {
    const synthetic: SupplementCatalogEntry[] = [
      {
        name: "Made-Up Eye Blend",
        dosages: ["1 softgel"],
        ingredients: overLimit,
      },
    ];
    const found = catalogUlExceedances(synthetic);
    expect(found).toEqual([
      {
        name: "Made-Up Eye Blend",
        dose: "1 softgel",
        nutrient: "zinc",
        total: 50,
        ul: 40,
        unit: "mg",
      },
    ]);
    const undeclared = found.filter((x) => {
      const e = catalogEntryByName(x.name, synthetic);
      return !e?.aboveUpperLimit?.some((n) => n.nutrient === x.nutrient);
    });
    expect(undeclared).toHaveLength(1);
  });

  it("finds a reason that names a nutrient its product never exceeds", () => {
    const synthetic: SupplementCatalogEntry[] = [
      {
        name: "Made-Up Eye Blend",
        dosages: ["1 softgel"],
        ingredients: overLimit,
        aboveUpperLimit: [
          { nutrient: "copper", reason: "Not the one it trips." },
        ],
      },
    ];
    const exceeded = new Set(
      catalogUlExceedances(synthetic).map((x) => `${x.name} ${x.nutrient}`)
    );
    expect(exceeded.has("Made-Up Eye Blend copper")).toBe(false);
    expect(exceeded.has("Made-Up Eye Blend zinc")).toBe(true);
  });

  it("stays silent on a synthetic blend that sits under every limit", () => {
    const synthetic: SupplementCatalogEntry[] = [
      {
        name: "Made-Up Mild Blend",
        dosages: ["1 capsule"],
        ingredients: [{ name: "Zinc", amount: "11 mg" }],
      },
    ];
    expect(catalogUlExceedances(synthetic)).toEqual([]);
  });

  it("skips an entry whose label amount cannot be read rather than counting a zero", () => {
    // The write boundary refuses "2,5 g" too (lib/intake-ingredients); a catalog entry
    // carrying one must not become a schema-valid zero that contributes to nothing.
    const synthetic: SupplementCatalogEntry[] = [
      {
        name: "Made-Up Unreadable",
        dosages: ["1 capsule"],
        ingredients: [{ name: "Zinc", amount: "2,5 g" }],
      },
    ];
    expect(catalogUlExceedances(synthetic)).toEqual([]);
  });
});
