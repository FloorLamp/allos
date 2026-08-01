// PURE TIER — the allergen entry vocabulary (#1676).
//
// The point of the module is not that it has a list; it is that the list and the
// canonicalizer keep an entered allergen INSIDE the two cross-checks that key on the
// substance string. So the assertions here run the real cross-check
// (crossCheckDrugAllergies) and the real cross-reactivity matcher against what the
// picker would store, and pin the no-widening rule that keeps a specific drug from
// being rewritten into its whole class.

import { describe, it, expect } from "vitest";
import {
  ALLERGEN_OPTIONS,
  allergenSearchTerms,
  canonicalAllergen,
  normalizeAllergenSubstance,
} from "@/lib/allergen-vocabulary";
import { crossCheckDrugAllergies } from "@/lib/drug-allergy";
import { findCrossReactivity } from "@/lib/allergen-cross-reactivity";

function allergyOn(substance: string) {
  return {
    id: 1,
    substance,
    substanceCode: null,
    substanceCodeSystem: null,
    reaction: "hives",
  };
}

const AMOXICILLIN = { id: 2, name: "Amoxicillin 500 mg", rxcui: null };

describe("the option list", () => {
  it("leads with the five class-level drug allergens", () => {
    // An empty query keeps the source order and the picker shows eight rows, so the
    // statements people actually record ("penicillin allergy") have to be first.
    expect(ALLERGEN_OPTIONS.slice(0, 5)).toEqual([
      "Aspirin (salicylates)",
      "Cephalosporin antibiotics",
      "NSAIDs (non-steroidal anti-inflammatory drugs)",
      "Penicillin-class antibiotics",
      "Sulfonamide (sulfa) antibiotics",
    ]);
  });

  it("offers no two options that fold to the same allergen", () => {
    const seen = new Map<string, string>();
    for (const option of ALLERGEN_OPTIONS) {
      const key = canonicalAllergen(option);
      expect(key).toBe(option);
      expect(seen.has(option)).toBe(false);
      seen.set(option, option);
    }
  });

  it("hides a dataset alias behind its canonical member rather than offering both", () => {
    expect(ALLERGEN_OPTIONS).toContain("Soybean");
    expect(ALLERGEN_OPTIONS).not.toContain("Soy");
    expect(allergenSearchTerms("Soybean")).toContain("soy");
  });
});

describe("every offered option stays inside a cross-check", () => {
  it("each class-level label resolves to its own drug class", () => {
    for (const label of ALLERGEN_OPTIONS.slice(0, 5)) {
      const hits = crossCheckDrugAllergies(
        [allergyOn(label)],
        [
          AMOXICILLIN,
          { id: 3, name: "Ibuprofen 200 mg", rxcui: null },
          { id: 4, name: "Bactrim DS", rxcui: null },
          { id: 5, name: "Cephalexin 500 mg", rxcui: null },
          { id: 6, name: "Aspirin 81 mg", rxcui: null },
        ]
      );
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  it("a food member resolves to its cross-reactivity family", () => {
    const matches = findCrossReactivity(["Soybean"]);
    expect(matches.map((m) => m.familyId)).toContain("birch-oas");
  });
});

describe("canonicalAllergen", () => {
  it("folds case, punctuation, and a naive plural", () => {
    expect(canonicalAllergen("PEANUTS")).toBe("Peanut");
    expect(canonicalAllergen("  peanut ")).toBe("Peanut");
    expect(canonicalAllergen("cows milk")).toBe("Cow's milk");
  });

  it("resolves a dataset alias onto its canonical member", () => {
    expect(canonicalAllergen("soy")).toBe("Soybean");
    expect(canonicalAllergen("soya")).toBe("Soybean");
  });

  it("never widens a specific drug into its class", () => {
    // Amoxil is amoxicillin, not "every penicillin". Rewriting it as the class
    // label would record a broader allergy than the person stated.
    expect(canonicalAllergen("amoxil")).toBe("Amoxil");
    expect(canonicalAllergen("AMOXICILLIN")).toBe("Amoxicillin");
  });

  it("returns null for an allergen the vocabulary does not know", () => {
    expect(canonicalAllergen("PCN")).toBeNull();
    expect(canonicalAllergen("dust mites")).toBeNull();
    expect(canonicalAllergen("   ")).toBeNull();
  });
});

describe("normalizeAllergenSubstance (the write path)", () => {
  it("stores the canonical spelling for a recognized alias", () => {
    expect(normalizeAllergenSubstance(" soy ")).toBe("Soybean");
  });

  it("stores an unrecognized allergen exactly as typed, trimmed", () => {
    expect(normalizeAllergenSubstance("  Blue dye #1 ")).toBe("Blue dye #1");
  });

  it("collapses the spellings of one allergen onto a single stored name", () => {
    // Two records of the same allergen must not read as two different allergens on
    // the emergency card, in the passport, or to the de-dup identity.
    const spellings = ["soy", "Soya", "SOYBEAN", "soybeans"];
    const stored = new Set(spellings.map(normalizeAllergenSubstance));
    expect([...stored]).toEqual(["Soybean"]);
  });

  it("a picked option is a spelling the cross-check sees, unlike a common abbreviation", () => {
    // "PCN" is the abbreviation people actually write, and it resolves to nothing —
    // the vocabulary can't rescue it, which is exactly why the field now OFFERS the
    // class-level name instead of leaving the user to invent one.
    expect(canonicalAllergen("PCN")).toBeNull();
    expect(crossCheckDrugAllergies([allergyOn("PCN")], [AMOXICILLIN])).toEqual(
      []
    );
    expect(
      crossCheckDrugAllergies(
        [allergyOn("Penicillin-class antibiotics")],
        [AMOXICILLIN]
      ).length
    ).toBe(1);
  });
});
