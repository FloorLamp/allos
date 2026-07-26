import { describe, expect, it } from "vitest";
import { biomarkerSuggestionSource } from "@/lib/supplement-suggestion-source";

describe("biomarkerSuggestionSource", () => {
  it("shows four unique biomarkers and summarizes the remainder", () => {
    expect(
      biomarkerSuggestionSource([
        "Vitamin D, 25-Hydroxy",
        "Ferritin",
        "Magnesium",
        "Vitamin B12",
        "Folate",
        "Ferritin",
        "Zinc",
      ])
    ).toBe(
      "New/changed biomarkers: Vitamin D, 25-Hydroxy, Ferritin, Magnesium, Vitamin B12 · +2 more"
    );
  });

  it("does not add overflow text to a short list", () => {
    expect(biomarkerSuggestionSource(["Ferritin", "Vitamin B12"])).toBe(
      "New/changed biomarkers: Ferritin, Vitamin B12"
    );
  });
});
