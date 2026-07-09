import { describe, it, expect } from "vitest";
import { normalizeGrowthInput, validateGrowthInput } from "@/lib/growth-input";

describe("normalizeGrowthInput", () => {
  it("converts a cm height to a height_cm sample", () => {
    const res = normalizeGrowthInput({
      height: "82.5",
      heightUnit: "cm",
      headCirc: "",
      headCircUnit: "cm",
    });
    expect(res).toEqual({ samples: [{ metric: "height_cm", value: 82.5 }] });
  });

  it("converts an inches height to canonical cm (rounded 1dp)", () => {
    const res = normalizeGrowthInput({
      height: "30",
      heightUnit: "in",
      headCirc: "",
      headCircUnit: "in",
    });
    // 30 in * 2.54 = 76.2 cm
    expect(res).toEqual({ samples: [{ metric: "height_cm", value: 76.2 }] });
  });

  it("collects both height and head circumference when both are given", () => {
    const res = normalizeGrowthInput({
      height: "82",
      heightUnit: "cm",
      headCirc: "48",
      headCircUnit: "cm",
    });
    expect(res).toEqual({
      samples: [
        { metric: "height_cm", value: 82 },
        { metric: "head_circumference_cm", value: 48 },
      ],
    });
  });

  it("errors when nothing is measured", () => {
    const res = normalizeGrowthInput({
      height: "",
      heightUnit: "cm",
      headCirc: "  ",
      headCircUnit: "cm",
    });
    expect(res).toEqual({ error: "Enter a height or head circumference." });
  });

  it("errors on an implausible height (out of the 30–260 cm band)", () => {
    const res = normalizeGrowthInput({
      height: "5",
      heightUnit: "cm",
      headCirc: "",
      headCircUnit: "cm",
    });
    expect(res).toEqual({ error: "That height looks out of range." });
  });

  it("errors on an implausible head circumference (out of 20–70 cm)", () => {
    const res = normalizeGrowthInput({
      height: "",
      heightUnit: "cm",
      headCirc: "5",
      headCircUnit: "cm",
    });
    expect(res).toEqual({
      error: "That head circumference looks out of range.",
    });
  });

  it("errors on a non-numeric height", () => {
    const res = normalizeGrowthInput({
      height: "tall",
      heightUnit: "cm",
      headCirc: "",
      headCircUnit: "cm",
    });
    expect(res).toEqual({ error: "Enter a valid height." });
  });
});

describe("validateGrowthInput", () => {
  it("returns null for valid input", () => {
    expect(
      validateGrowthInput({
        height: "82",
        heightUnit: "cm",
        headCirc: "",
        headCircUnit: "cm",
      })
    ).toBeNull();
  });

  it("returns the error message for invalid input", () => {
    expect(
      validateGrowthInput({
        height: "",
        heightUnit: "cm",
        headCirc: "",
        headCircUnit: "cm",
      })
    ).toBe("Enter a height or head circumference.");
  });
});
