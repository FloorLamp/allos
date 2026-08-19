import { describe, expect, it } from "vitest";
import {
  readIngredientAmount,
  normalizeIngredientDrafts,
  unreadableAmountMessage,
  ingredientNames,
  ingredientLine,
  ingredientSummary,
} from "@/lib/intake-ingredients";

// Pure tests for the write boundary and display of label composition (issue #2856).
// Synthetic labels only; the amounts are ordinary supplement-facts figures.

// The rows a draft normalized to, or a failure of the assertion. Keeps each case
// reading as one claim about one input.
function rowsOf(drafts: { name: string; amount_text: string }[]) {
  const result = normalizeIngredientDrafts(drafts);
  if (!result.ok) throw new Error(`refused: ${result.amountText}`);
  return result.rows;
}

describe("readIngredientAmount", () => {
  it("keeps milligrams and micrograms as they are stated", () => {
    expect(readIngredientAmount("11 mg")).toEqual({
      kind: "quantity",
      amount: 11,
      unit: "mg",
    });
    expect(readIngredientAmount("200 mcg")).toEqual({
      kind: "quantity",
      amount: 200,
      unit: "mcg",
    });
  });

  it("folds grams to milligrams at the boundary", () => {
    expect(readIngredientAmount("2 g")).toEqual({
      kind: "quantity",
      amount: 2000,
      unit: "mg",
    });
  });

  it("keeps IU as IU, because an IU is defined per substance", () => {
    // Converting here would need to know WHICH nutrient this is — the matchers'
    // question, not the write boundary's. dri.toNutrientUnit does it downstream.
    expect(readIngredientAmount("1000 IU")).toEqual({
      kind: "quantity",
      amount: 1000,
      unit: "iu",
    });
  });

  // ---- The comma cases (review of #2856) ----------------------------------------
  //
  // These are the exact strings that used to become a schema-valid, fully-present,
  // completely wrong number. A US label writes its thousands with a comma and the
  // repeater asks the person to type the amount as the label writes it.

  it("reads grouped thousands separators as the number the label states", () => {
    expect(readIngredientAmount("1,000 mg")).toEqual({
      kind: "quantity",
      amount: 1000,
      unit: "mg",
    });
    expect(readIngredientAmount("5,000 IU")).toEqual({
      kind: "quantity",
      amount: 5000,
      unit: "iu",
    });
    expect(readIngredientAmount("1,500 mg")).toEqual({
      kind: "quantity",
      amount: 1500,
      unit: "mg",
    });
    expect(readIngredientAmount("10,000 IU")).toEqual({
      kind: "quantity",
      amount: 10000,
      unit: "iu",
    });
  });

  it("refuses a comma that is not a thousands group rather than guessing", () => {
    // A European decimal comma. Reading it as 2.5 g or as 25 g is a coin flip, and
    // the old scan read it as 5 g — ten times the larger reading.
    expect(readIngredientAmount("2,5 g")).toEqual({ kind: "unreadable" });
    expect(readIngredientAmount("1,00 mg")).toEqual({ kind: "unreadable" });
  });

  it("refuses anything else carrying digits that is not one quantity", () => {
    expect(readIngredientAmount("1-2 mg")).toEqual({ kind: "unreadable" });
    expect(readIngredientAmount("10 mg (as citrate) 5 mg")).toEqual({
      kind: "unreadable",
    });
    expect(readIngredientAmount("500")).toEqual({ kind: "unreadable" });
    expect(readIngredientAmount("a pinch of 3")).toEqual({
      kind: "unreadable",
    });
  });

  it("reads a label that states no quantity as none, not as unreadable", () => {
    expect(readIngredientAmount("Proprietary blend")).toEqual({ kind: "none" });
    expect(readIngredientAmount("")).toEqual({ kind: "none" });
    expect(readIngredientAmount(null)).toEqual({ kind: "none" });
  });
});

describe("normalizeIngredientDrafts", () => {
  it("preserves the label text beside the canonical reading", () => {
    expect(rowsOf([{ name: " Zinc ", amount_text: " 11 mg " }])).toEqual([
      { name: "Zinc", amount_text: "11 mg", amount: 11, unit: "mg" },
    ]);
  });

  it("keeps a named ingredient with no amount", () => {
    // "This blend contains St. John's Wort" is the whole point of the interaction
    // belt even when the label hides the milligrams inside a proprietary blend.
    expect(rowsOf([{ name: "St. John's Wort", amount_text: "" }])).toEqual([
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
      rowsOf([
        { name: "", amount_text: "" },
        { name: "   ", amount_text: "11 mg" },
      ])
    ).toEqual([]);
  });

  it("refuses the whole save when one amount cannot be read", () => {
    // A niacin row at "1,000 mg" is 28x the adult upper limit. It must not become a
    // zero, and it must not quietly become "no stated amount" either — both leave the
    // UL layer with a number it cannot trust and no way to know.
    const result = normalizeIngredientDrafts([
      { name: "Vitamin C", amount_text: "500 mg" },
      { name: "Astaxanthin", amount_text: "2,5 g" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.name).toBe("Astaxanthin");
    expect(result.amountText).toBe("2,5 g");
    // The message names the exact string, so the person can see which row to fix.
    expect(unreadableAmountMessage(result.name, result.amountText)).toContain(
      "2,5 g"
    );
  });

  it("carries a thousands-separated label through to the stored amount", () => {
    expect(rowsOf([{ name: "Niacin", amount_text: "1,000 mg" }])).toEqual([
      { name: "Niacin", amount_text: "1,000 mg", amount: 1000, unit: "mg" },
    ]);
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
