import { describe, it, expect } from "vitest";
import {
  suggestFoods,
  isLowFlag,
  isHighFlag,
  foodSuggestSignalKey,
  foodReduceSignalKey,
  FOOD_SUGGEST_PREFIX,
  FOOD_REDUCE_PREFIX,
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

describe("isHighFlag (#775)", () => {
  it("treats high + non-optimal-high + abnormal as high-side, nothing else", () => {
    expect(isHighFlag("high")).toBe(true);
    expect(isHighFlag("non-optimal-high")).toBe(true);
    expect(isHighFlag("abnormal")).toBe(true);
    expect(isHighFlag("High")).toBe(true);
    expect(isHighFlag("low")).toBe(false);
    expect(isHighFlag("non-optimal-low")).toBe(false);
    expect(isHighFlag("normal")).toBe(false);
    expect(isHighFlag(null)).toBe(false);
  });

  it("isLowFlag and isHighFlag are disjoint on every flag", () => {
    for (const f of [
      "low",
      "high",
      "non-optimal-low",
      "non-optimal-high",
      "abnormal",
      "normal",
    ]) {
      expect(isLowFlag(f) && isHighFlag(f)).toBe(false);
    }
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

describe("suggestFoods — dietary preferences (#975): filter + substitute", () => {
  it("a vegetarian's low iron leads with legumes (non-heme), not red meat", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Ferritin", flag: "low" }],
        // Vegetarian preset excludes the animal groups.
        excludedGroups: [
          "fatty_fish",
          "lean_fish",
          "shellfish",
          "poultry",
          "red_meat",
          "processed_meat",
        ],
      })
    );
    const iron = out.find((s) => s.key === "iron");
    expect(iron).toBeTruthy();
    // The red-meat source is dropped; the legume source leads. Never empty.
    expect(iron!.foods.map((f) => f.foodGroup)).toContain("legumes");
    expect(iron!.foods.map((f) => f.foodGroup)).not.toContain("red_meat");
    // A preference note explains the substitution (never a safety note).
    expect(iron!.safetyNotes.some((n) => n.kind === "preference")).toBe(true);
  });

  it("keeps the suggestion (never empty) when every source is excluded", () => {
    // Exclude BOTH iron sources — the shortfall must still surface.
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Ferritin", flag: "low" }],
        excludedGroups: ["red_meat", "processed_meat", "legumes"],
      })
    );
    const iron = out.find((s) => s.key === "iron");
    expect(iron).toBeTruthy();
    expect(iron!.foods.length).toBeGreaterThan(0);
  });

  it("no preferences leaves suggestions unchanged", () => {
    const withNone = suggestFoods(
      baseInput({ flagged: [{ name: "Ferritin", flag: "low" }] })
    );
    const iron = withNone.find((s) => s.key === "iron");
    expect(iron!.safetyNotes.some((n) => n.kind === "preference")).toBe(false);
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

// ── #774: expanded low-side coverage ──────────────────────────────────────────
describe("suggestFoods — expanded low-nutrient coverage (#774)", () => {
  it("low selenium → a brazil-nuts add suggestion (the motivating gap)", () => {
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "Selenium", flag: "low" }] })
    );
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.key).toBe("selenium");
    expect(s.direction).toBe("add");
    expect(s.dedupeKey).toBe(foodSuggestSignalKey("selenium"));
    expect(s.foods[0].food.toLowerCase()).toContain("brazil");
  });

  it("each newly-mapped flaggable nutrient yields a suggestion", () => {
    const cases: [string, string][] = [
      ["Zinc", "zinc"],
      ["Iodine", "iodine"],
      ["Calcium", "calcium"],
      ["Copper", "copper"],
      ["Vitamin A (Retinol)", "vitamin-a"],
      ["Vitamin E (Alpha-Tocopherol)", "vitamin-e"],
      ["Molybdenum", "molybdenum"],
    ];
    for (const [biomarker, key] of cases) {
      const out = suggestFoods(
        baseInput({ flagged: [{ name: biomarker, flag: "low" }] })
      );
      expect(
        out.map((s) => s.key),
        biomarker
      ).toContain(key);
    }
  });

  it("Wilson disease DROPS the copper suggestion (increasing copper is hazardous)", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Copper", flag: "low" }],
        conditions: ["Wilson disease"],
      })
    );
    expect(out).toEqual([]);
  });

  it("high blood calcium condition (hypercalcemia) DROPS the calcium suggestion", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Calcium", flag: "low" }],
        conditions: ["Hypercalcemia"],
      })
    );
    expect(out).toEqual([]);
  });
});

// ── #775: reduce/avoid direction ──────────────────────────────────────────────
describe("suggestFoods — reduce direction (#775)", () => {
  it("high LDL → a limit-tier reduce suggestion (fried food, processed meat)", () => {
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "LDL Cholesterol", flag: "high" }] })
    );
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.key).toBe("ldl-apob");
    expect(s.direction).toBe("reduce");
    expect(s.dedupeKey).toBe(foodReduceSignalKey("ldl-apob"));
    expect(s.dedupeKey.startsWith(FOOD_REDUCE_PREFIX)).toBe(true);
    const foods = s.foods.map((f) => f.food.toLowerCase()).join(" ");
    expect(foods).toMatch(/fried/);
    expect(foods).toMatch(/processed|red meat/);
    expect(s.triggeredBy).toEqual(["LDL Cholesterol"]);
  });

  it("high A1c → reduce added sugar / sugary drinks / refined grains", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [{ name: "Hemoglobin A1c", flag: "non-optimal-high" }],
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("glucose");
    const groups = out[0].foods.map((f) => f.foodGroup);
    expect(groups).toContain("added_sugar");
    expect(groups).toContain("sugary_drinks");
    expect(groups).toContain("refined_grains");
  });

  it("collapses LDL + ApoB both high to ONE reduce suggestion (family-keyed)", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [
          { name: "LDL Cholesterol", flag: "high" },
          { name: "ApoB", flag: "high" },
        ],
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].triggeredBy).toEqual(["LDL Cholesterol", "ApoB"]);
  });

  it("an IN-RANGE (normal) reading yields no reduce suggestion (true negative)", () => {
    expect(
      suggestFoods(
        baseInput({ flagged: [{ name: "LDL Cholesterol", flag: "normal" }] })
      )
    ).toEqual([]);
  });

  it("a LOW reading never triggers a reduce suggestion (only the add path)", () => {
    // Sodium reduce entry is high-side; a low sodium is not in any low ADD entry.
    expect(
      suggestFoods(baseInput({ flagged: [{ name: "Sodium", flag: "low" }] }))
    ).toEqual([]);
  });

  it("add and reduce dedupe namespaces never collide", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [
          { name: "Ferritin", flag: "low" },
          { name: "Glucose", flag: "high" },
        ],
      })
    );
    const add = out.find((s) => s.direction === "add")!;
    const reduce = out.find((s) => s.direction === "reduce")!;
    expect(add.dedupeKey.startsWith(FOOD_SUGGEST_PREFIX)).toBe(true);
    expect(reduce.dedupeKey.startsWith(FOOD_REDUCE_PREFIX)).toBe(true);
    expect(add.dedupeKey).not.toBe(reduce.dedupeKey);
    // Add suggestions come first, reduce appended after (curated order).
    expect(out.map((s) => s.direction)).toEqual(["add", "reduce"]);
  });
});

// ── #775: mercury tempers the omega-3 fish suggestion ─────────────────────────
describe("suggestFoods — mercury qualifier on omega-3 (#775)", () => {
  it("high mercury + low omega-3 → the fish suggestion carries a low-mercury-species note", () => {
    const out = suggestFoods(
      baseInput({
        flagged: [
          { name: "Omega-3 EPA", flag: "low" },
          { name: "Mercury", flag: "high" },
        ],
      })
    );
    // Mercury attaches to / qualifies the omega-3 add suggestion — never a standalone.
    const omega = out.find((s) => s.key === "omega-3")!;
    expect(omega).toBeTruthy();
    expect(omega.direction).toBe("add");
    const note = omega.safetyNotes.find((n) => n.kind === "biomarker");
    expect(note).toBeTruthy();
    expect(note!.text.toLowerCase()).toContain("mercury");
    expect(note!.text.toLowerCase()).toMatch(/tuna|swordfish|king mackerel/);
    // No standalone mercury/reduce card was emitted.
    expect(out).toHaveLength(1);
  });

  it("high mercury with omega-3 in range → no fish suggestion at all (nothing to temper)", () => {
    // Mercury is a qualifier, not a standalone reduce entry — with no fish being
    // encouraged there is no suggestion to attach to.
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "Mercury", flag: "high" }] })
    );
    expect(out).toEqual([]);
  });

  it("low omega-3 with mercury NOT elevated → the plain fish suggestion, no mercury note", () => {
    const out = suggestFoods(
      baseInput({ flagged: [{ name: "Omega-3 EPA", flag: "low" }] })
    );
    expect(out).toHaveLength(1);
    expect(out[0].safetyNotes.some((n) => n.kind === "biomarker")).toBe(false);
  });
});
