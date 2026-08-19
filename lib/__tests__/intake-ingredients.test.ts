import { describe, expect, it } from "vitest";
import {
  parseIngredientAmount,
  normalizeIngredientDrafts,
  ingredientNames,
  ingredientLine,
  ingredientSummary,
} from "@/lib/intake-ingredients";

// Pure tests for the write boundary and display of label composition (issue #2856).
// Synthetic labels only; the amounts are ordinary supplement-facts figures.

describe("parseIngredientAmount", () => {
  it("keeps milligrams and micrograms as they are stated", () => {
    expect(parseIngredientAmount("11 mg")).toEqual({ amount: 11, unit: "mg" });
    expect(parseIngredientAmount("200 mcg")).toEqual({
      amount: 200,
      unit: "mcg",
    });
  });

  it("folds grams to milligrams at the boundary", () => {
    expect(parseIngredientAmount("2 g")).toEqual({ amount: 2000, unit: "mg" });
  });

  it("keeps IU as IU, because an IU is defined per substance", () => {
    // Converting here would need to know WHICH nutrient this is — the matchers'
    // question, not the write boundary's. dri.toNutrientUnit does it downstream.
    expect(parseIngredientAmount("1000 IU")).toEqual({
      amount: 1000,
      unit: "iu",
    });
  });

  it("returns null for a label that states no quantity", () => {
    expect(parseIngredientAmount("Proprietary blend")).toBeNull();
    expect(parseIngredientAmount("")).toBeNull();
    expect(parseIngredientAmount(null)).toBeNull();
  });
});

describe("normalizeIngredientDrafts", () => {
  it("preserves the label text beside the canonical reading", () => {
    expect(
      normalizeIngredientDrafts([{ name: " Zinc ", amount_text: " 11 mg " }])
    ).toEqual([{ name: "Zinc", amount_text: "11 mg", amount: 11, unit: "mg" }]);
  });

  it("keeps a named ingredient with no amount", () => {
    // "This blend contains St. John's Wort" is the whole point of the interaction
    // belt even when the label hides the milligrams inside a proprietary blend.
    expect(
      normalizeIngredientDrafts([{ name: "St. John's Wort", amount_text: "" }])
    ).toEqual([
      {
        name: "St. John's Wort",
        amount_text: null,
        amount: null,
        unit: null,
      },
    ]);
  });

  it("drops a blank row and an amount that names nothing", () => {
    expect(
      normalizeIngredientDrafts([
        { name: "", amount_text: "" },
        { name: "   ", amount_text: "11 mg" },
      ])
    ).toEqual([]);
  });

  it("never fabricates a zero for an unparseable amount", () => {
    const [row] = normalizeIngredientDrafts([
      { name: "Mushroom complex", amount_text: "a pinch" },
    ]);
    expect(row.amount).toBeNull();
    expect(row.unit).toBeNull();
    expect(row.amount_text).toBe("a pinch");
  });
});

describe("names and display", () => {
  it("hands the matchers plain trimmed names", () => {
    expect(ingredientNames([{ name: " Lutein " }, { name: "" }])).toEqual([
      "Lutein",
    ]);
  });

  it("shows the label's own words", () => {
    expect(
      ingredientLine({
        name: "Zinc",
        amount_text: "11 mg",
        amount: 11,
        unit: "mg",
      })
    ).toBe("Zinc 11 mg");
  });

  it("falls back to the canonical pair, then to the bare name", () => {
    expect(
      ingredientLine({
        name: "Vitamin E",
        amount_text: null,
        amount: 200,
        unit: "iu",
      })
    ).toBe("Vitamin E 200 IU");
    expect(
      ingredientLine({
        name: "Ashwagandha",
        amount_text: null,
        amount: null,
        unit: null,
      })
    ).toBe("Ashwagandha");
  });

  it("joins a label into one summary line", () => {
    expect(
      ingredientSummary([
        { name: "Lutein", amount_text: "10 mg", amount: 10, unit: "mg" },
        { name: "Zeaxanthin", amount_text: "2 mg", amount: 2, unit: "mg" },
      ])
    ).toBe("Lutein 10 mg · Zeaxanthin 2 mg");
  });
});
