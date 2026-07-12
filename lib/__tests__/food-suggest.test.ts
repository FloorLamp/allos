import { describe, it, expect } from "vitest";
import {
  suggestFoods,
  isLowFlag,
  foodSuggestSignalKey,
  type FoodSuggestInput,
} from "@/lib/food-suggest";

// Pure-tier tests for the deterministic biomarker→food engine (issue #577). No DB —
// the DB gather (getFoodSuggestions) is exercised in the DB-tier builder test.

function baseInput(over: Partial<FoodSuggestInput> = {}): FoodSuggestInput {
  return {
    flagged: [],
    allergens: [],
    medications: [],
    conditions: [],
    situations: [],
    ...over,
  };
}

describe("isLowFlag", () => {
  it("treats low + non-optimal-low as low-side, nothing else", () => {
    expect(isLowFlag("low")).toBe(true);
    expect(isLowFlag("non-optimal-low")).toBe(true);
    expect(isLowFlag("Low")).toBe(true);
    expect(isLowFlag("high")).toBe(false);
    expect(isLowFlag("non-optimal-high")).toBe(false);
    expect(isLowFlag("normal")).toBe(false);
    expect(isLowFlag(null)).toBe(false);
  });
});

describe("suggestFoods — the motivating example", () => {
  it("low omega-3 index → fatty fish, 2 servings/wk", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Omega-3 Total (OmegaCheck)", flag: "low" }],
      })
    );
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.key).toBe("omega-3");
    expect(s.dedupeKey).toBe(foodSuggestSignalKey("omega-3"));
    expect(s.foods[0].food.toLowerCase()).toContain("fatty fish");
    expect(s.foods[0].isAlternative).toBe(false);
    expect(s.triggeredBy).toEqual(["Omega-3 Total (OmegaCheck)"]);
  });

  it("collapses multiple flagged omega-3 members to ONE suggestion (family-keyed)", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [
          { name: "Omega-3 EPA", flag: "low" },
          { name: "Omega-3 DHA", flag: "non-optimal-low" },
        ],
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].triggeredBy).toEqual(["Omega-3 EPA", "Omega-3 DHA"]);
  });

  it("does NOT suggest for a high reading", () => {
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "Omega-3 EPA", flag: "high" }] })
    );
    expect(out).toEqual([]);
  });
});

describe("suggestFoods — allergy screen", () => {
  it("a fish allergy strikes fatty fish and surfaces the algae/ALA alternative", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Omega-3 EPA", flag: "low" }],
        allergens: ["fish"],
      })
    );
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.foods).toHaveLength(1);
    expect(s.foods[0].isAlternative).toBe(true);
    expect(s.foods[0].food.toLowerCase()).toMatch(/walnut|flax|algae/);
    expect(s.safetyNotes.some((n) => n.kind === "allergy")).toBe(true);
  });
});

describe("suggestFoods — medication screen (food–drug inverse)", () => {
  it("a warfarin stack carries the vitamin-K consistency note on leafy-greens foods, never dropped", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Folate", flag: "low" }],
        medications: [
          { name: "Warfarin", rxcui: "11289", rxcuiIngredients: null },
        ],
      })
    );
    expect(out).toHaveLength(1);
    const s = out[0];
    // Suggestion still made (foods present), but carries a medication note.
    expect(s.foods.length).toBeGreaterThan(0);
    const medNote = s.safetyNotes.find((n) => n.kind === "medication");
    expect(medNote).toBeTruthy();
    expect(medNote!.text.toLowerCase()).toMatch(
      /vitamin k|consistent|warfarin/
    );
  });

  it("no vitamin-K note when the stack has no anticoagulant", () => {
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "Folate", flag: "low" }] })
    );
    expect(out[0].safetyNotes.some((n) => n.kind === "medication")).toBe(false);
  });
});

describe("suggestFoods — condition/situation screen", () => {
  it("pregnancy annotates the fatty-fish suggestion with a low-mercury caution", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Omega-3 EPA", flag: "low" }],
        situations: ["Pregnancy"],
      })
    );
    expect(out).toHaveLength(1);
    const note = out[0].safetyNotes.find((n) => n.kind === "condition");
    expect(note).toBeTruthy();
    expect(note!.text.toLowerCase()).toContain("mercury");
  });

  it("CKD DROPS the potassium suggestion entirely (increasing it is hazardous)", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Potassium", flag: "low" }],
        conditions: ["Chronic kidney disease, stage 3"],
      })
    );
    expect(out).toEqual([]);
  });

  it("without CKD, low potassium yields a produce suggestion", () => {
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "Potassium", flag: "low" }] })
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("potassium");
  });
});

describe("suggestFoods — determinism + ordering", () => {
  it("emits in curated map order and is stable across calls", () => {
    const input = baseInput({
      flagged: [
        { name: "Potassium", flag: "low" },
        { name: "Ferritin", flag: "low" },
        { name: "Omega-3 EPA", flag: "low" },
      ],
    });
    const a = suggestFoods(input).map((s) => s.key);
    const b = suggestFoods(input).map((s) => s.key);
    expect(a).toEqual(b);
    // Curated order: omega-3 before iron before potassium.
    expect(a).toEqual(["omega-3", "iron", "potassium"]);
  });
});
