import { describe, it, expect } from "vitest";
import {
  allergenConflict,
  allergenConflicts,
  interactionConflict,
  conditionConflict,
  screenSuggestionSafety,
  type SafetyMedication,
} from "../supplement-safety";

describe("allergenConflict (#413)", () => {
  it("drops a supplement that directly contains a recorded allergen", () => {
    // The headline scenario: fish allergy → fish oil for high triglycerides.
    expect(allergenConflict("Fish Oil", ["fish"])).toEqual({
      allergen: "fish",
    });
    expect(allergenConflict("Omega-3 Fish Oil", ["Fish"])?.allergen).toBe(
      "Fish"
    );
  });

  it("matches a multi-word allergen and depluralizes", () => {
    expect(allergenConflict("Tree Nut Complex", ["tree nut"])?.allergen).toBe(
      "tree nut"
    );
    expect(allergenConflict("Egg Protein Powder", ["eggs"])?.allergen).toBe(
      "eggs"
    );
  });

  it("does not match inside an unrelated longer word", () => {
    // "egg" must not fire on "eggplant".
    expect(allergenConflict("Eggplant Extract", ["egg"])).toBeNull();
    // No allergen at all.
    expect(
      allergenConflict("Magnesium Glycinate", ["fish", "penicillin"])
    ).toBeNull();
  });

  it("drops a cross-reactive relative via the #153 dataset", () => {
    // Crustacean shellfish share tropomyosin: a shrimp allergy should drop krill.
    const hit = allergenConflict("Krill Oil", ["shrimp"]);
    expect(hit?.viaCrossReactivity).toBeTruthy();
    expect(hit?.allergen.toLowerCase()).toContain("shrimp");
  });

  it("ignores blank / whitespace allergens", () => {
    expect(allergenConflict("Fish Oil", ["", "   "])).toBeNull();
  });
});

describe("interactionConflict (#413)", () => {
  const warfarin: SafetyMedication = {
    name: "Warfarin",
    rxcui: null,
    rxcuiIngredients: null,
  };
  const lisinopril: SafetyMedication = {
    name: "Lisinopril",
    rxcui: null,
    rxcuiIngredients: null,
  };

  it("drops vitamin K when the profile takes warfarin", () => {
    const hit = interactionConflict("Vitamin K2 (MK-7)", [warfarin]);
    expect(hit?.medication).toBe("Warfarin");
  });

  it("drops potassium when the profile takes an ACE inhibitor", () => {
    const hit = interactionConflict("Potassium Citrate", [lisinopril]);
    expect(hit?.medication).toBe("Lisinopril");
  });

  it("does not drop an unrelated supplement", () => {
    expect(
      interactionConflict("Vitamin D3", [warfarin, lisinopril])
    ).toBeNull();
    // Timing-only interactions (calcium × levothyroxine) are NOT a hard drop.
    expect(
      interactionConflict("Calcium Citrate", [
        { name: "Levothyroxine", rxcui: null, rxcuiIngredients: null },
      ])
    ).toBeNull();
  });

  it("returns null with no medications", () => {
    expect(interactionConflict("Vitamin K", [])).toBeNull();
  });
});

describe("conditionConflict (#657)", () => {
  it("drops supplemental potassium when the profile has CKD", () => {
    const hit = conditionConflict("Potassium Citrate", [
      "Chronic kidney disease, stage 3",
    ]);
    expect(hit?.condition).toBe("Chronic kidney disease, stage 3");
    expect(hit?.nutrient).toBe("potassium");
    expect(hit?.caution.toLowerCase()).toContain("kidney");
  });

  it("drops supplemental magnesium when the profile has CKD", () => {
    const hit = conditionConflict("Magnesium Glycinate", [
      "chronic kidney disease",
    ]);
    expect(hit?.nutrient).toBe("magnesium");
  });

  it("does not drop an unrelated nutrient or an unrelated condition", () => {
    // CKD does not contraindicate vitamin D.
    expect(
      conditionConflict("Vitamin D3", ["chronic kidney disease"])
    ).toBeNull();
    // Potassium with an unrelated condition is fine.
    expect(conditionConflict("Potassium Citrate", ["asthma"])).toBeNull();
  });

  it("returns null with no conditions", () => {
    expect(conditionConflict("Potassium Citrate", [])).toBeNull();
    expect(conditionConflict("Potassium Citrate", ["", "  "])).toBeNull();
  });
});

describe("screenSuggestionSafety (#413)", () => {
  it("reports the allergen field with a self-contained reason", () => {
    const drop = screenSuggestionSafety(
      { name: "Fish Oil" },
      { allergens: ["fish"], medications: [], conditions: [] }
    );
    expect(drop?.field).toBe("allergen");
    expect(drop?.detail).toContain("fish");
  });

  it("checks brand/product text too, not just the name", () => {
    const drop = screenSuggestionSafety(
      { name: "Omega-3", product: "Wild Fish Oil Softgels" },
      { allergens: ["fish"], medications: [], conditions: [] }
    );
    expect(drop?.field).toBe("allergen");
  });

  it("reports the interaction field when the name matches a med interaction", () => {
    const drop = screenSuggestionSafety(
      { name: "Vitamin K" },
      {
        allergens: [],
        medications: [
          { name: "Warfarin", rxcui: null, rxcuiIngredients: null },
        ],
        conditions: [],
      }
    );
    expect(drop?.field).toBe("interaction");
    expect(drop?.detail).toContain("Warfarin");
  });

  it("reports the condition field for a contraindicated nutrient regardless of model output (#657)", () => {
    // The headline #657 scenario: a potassium suggestion for a CKD profile is dropped
    // by the deterministic belt even though the model surfaced it.
    const drop = screenSuggestionSafety(
      { name: "Potassium Citrate" },
      {
        allergens: [],
        medications: [],
        conditions: ["Chronic kidney disease, stage 4"],
      }
    );
    expect(drop?.field).toBe("condition");
    expect(drop?.detail).toContain("Chronic kidney disease, stage 4");
  });

  it("still drops an allergen the belt was handed even if it was clinically resolved (#691)", () => {
    // The belt is status-BLIND by design: it screens whatever allergen substances the
    // gather feeds it. #691's fix restores resolved allergies to that gather
    // (getSuggestSafetyContext), so a resolved "fish" allergy must still drop fish
    // oil here — the DB-tier test pins that the gather actually includes it.
    const drop = screenSuggestionSafety(
      { name: "Omega-3", product: "Wild Fish Oil" },
      { allergens: ["fish"], medications: [], conditions: [] }
    );
    expect(drop?.field).toBe("allergen");
    expect(drop?.detail).toContain("fish");
  });

  it("passes a clean suggestion", () => {
    expect(
      screenSuggestionSafety(
        { name: "Magnesium Glycinate" },
        {
          allergens: ["fish"],
          medications: [
            { name: "Warfarin", rxcui: null, rxcuiIngredients: null },
          ],
          conditions: ["hypertension"],
        }
      )
    ).toBeNull();
  });
});

// ── allergenConflicts: the plural sibling (#5230) ───────────────────────────────
//
// `allergenConflict` returns at the first DIRECT hit and again at the first
// CROSS-REACTIVE hit. A screen that drops the whole suggestion can only use one, so
// that is right for it; a RECEIPT that states what was found reads a second hit as a
// silence. Both loops, one change.
describe("allergenConflicts (#5230)", () => {
  // Rules out fixing only the cross-reactive loop.
  it("returns every direct hit, not just the first", () => {
    expect(
      allergenConflicts("Peanut Soybean Bar", ["Peanut", "Soybean"])
    ).toEqual([{ allergen: "Peanut" }, { allergen: "Soybean" }]);
  });

  // Rules out fixing only the direct loop: on the shipped matcher the krill hit is
  // dropped outright because Soybean is found in the name first.
  it("keeps a cross-reactive hit a direct hit used to swallow", () => {
    const hits = allergenConflicts("Krill Oil with Soybean Oil", [
      "Shrimp",
      "Soybean",
    ]);
    expect(hits.map((h) => h.allergen)).toEqual(["Soybean", "Shrimp"]);
    expect(hits[1].viaCrossReactivity).toBe("krill");
  });

  // The unjoined triggers, which is what a composing caller dedupes on — the joined
  // display string is a pseudo-allergen ("Shrimp, Crab") no vocabulary knows.
  it("carries a cross-reactive hit's triggers unjoined, and a direct hit's not at all", () => {
    const [cross] = allergenConflicts("Krill Oil", ["Shrimp", "Crab"]);
    expect(cross.allergen).toBe("Shrimp, Crab");
    expect(cross.triggers).toEqual(["Shrimp", "Crab"]);
    expect(allergenConflicts("Fish Oil", ["Fish"])[0].triggers).toBeUndefined();
  });

  // The singular form is exactly the first of these — one core, two callers.
  it("is the same answer allergenConflict gives, first element", () => {
    for (const [text, allergens] of [
      ["Krill Oil with Soybean Oil", ["Shrimp", "Soybean"]],
      ["Magnesium Glycinate", ["fish"]],
      ["Fish Oil", ["fish"]],
    ] as const) {
      expect(allergenConflict(text, [...allergens])).toEqual(
        allergenConflicts(text, [...allergens])[0] ?? null
      );
    }
  });
});
