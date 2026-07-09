import { describe, expect, it } from "vitest";
import {
  isTotalIgE,
  isAllergenSpecificIgE,
  allergenFromIgEName,
  rastClassFromValue,
  isSensitizedIgE,
  allergenKey,
  buildAllergiesView,
  type IgESensitizationInput,
  type StoredAllergyInput,
} from "../allergy-ige";

describe("total IgE exclusion", () => {
  it("recognizes total serum IgE by name and LOINC", () => {
    expect(isTotalIgE("IgE")).toBe(true);
    expect(isTotalIgE("Immunoglobulin E")).toBe(true);
    expect(isTotalIgE("IgE, Total")).toBe(true);
    expect(isTotalIgE("anything", "19113-0")).toBe(true);
  });
  it("does not treat an allergen IgE as total", () => {
    expect(isTotalIgE("Peanut IgE")).toBe(false);
  });
  it("total IgE is not allergen-specific", () => {
    expect(isAllergenSpecificIgE("IgE")).toBe(false);
    expect(isAllergenSpecificIgE("Total IgE", "19113-0")).toBe(false);
  });
});

describe("allergen-specific IgE detection", () => {
  it("detects allergen IgE names", () => {
    expect(isAllergenSpecificIgE("Peanut IgE")).toBe(true);
    expect(isAllergenSpecificIgE("Cat Dander IgE Ab")).toBe(true);
    expect(isAllergenSpecificIgE("Dust Mite d1 IgE")).toBe(true);
    expect(isAllergenSpecificIgE("Egg White IgE [Units/volume]")).toBe(true);
    expect(isAllergenSpecificIgE("Birch RAST")).toBe(true);
  });
  it("rejects non-IgE analytes", () => {
    expect(isAllergenSpecificIgE("Hemoglobin A1c")).toBe(false);
    expect(isAllergenSpecificIgE("")).toBe(false);
  });
});

describe("allergen name extraction", () => {
  it("strips IgE/Ab/units boilerplate", () => {
    expect(allergenFromIgEName("Peanut IgE")).toBe("Peanut");
    expect(allergenFromIgEName("Cat Dander IgE Ab")).toBe("Cat Dander");
    expect(allergenFromIgEName("Egg White IgE [Units/volume]")).toBe(
      "Egg White"
    );
    expect(allergenFromIgEName("Dust Mite d1 IgE")).toBe("Dust Mite");
  });
  it("returns null for bare IgE", () => {
    expect(allergenFromIgEName("IgE")).toBe(null);
  });
});

describe("RAST class parsing", () => {
  it("parses class from text and integers", () => {
    expect(rastClassFromValue("Class 3")).toBe(3);
    expect(rastClassFromValue("class III")).toBe(3);
    expect(rastClassFromValue("0")).toBe(0);
    expect(rastClassFromValue(null, 4)).toBe(4);
    expect(rastClassFromValue("12.5 kU/L")).toBe(null);
    expect(rastClassFromValue(null, 12.5)).toBe(null);
  });
});

describe("IgE positivity", () => {
  it("is positive when flagged high or class ≥ 1", () => {
    expect(
      isSensitizedIgE({ flag: "high", value: "12.5", valueNum: 12.5 })
    ).toBe(true);
    expect(
      isSensitizedIgE({ flag: null, value: "Class 2", valueNum: null })
    ).toBe(true);
    expect(
      isSensitizedIgE({ flag: "abnormal", value: null, valueNum: null })
    ).toBe(true);
    expect(
      isSensitizedIgE({ flag: null, value: "positive", valueNum: null })
    ).toBe(true);
  });
  it("is negative below threshold / class 0 / no signal", () => {
    expect(
      isSensitizedIgE({ flag: null, value: "Class 0", valueNum: null })
    ).toBe(false);
    expect(
      isSensitizedIgE({ flag: "normal", value: "0.1", valueNum: 0.1 })
    ).toBe(false);
    expect(isSensitizedIgE({ flag: null, value: null, valueNum: null })).toBe(
      false
    );
  });
});

describe("allergenKey + merge/dedup", () => {
  it("normalizes for dedup", () => {
    expect(allergenKey("Peanut")).toBe("peanut");
    expect(allergenKey("Cat Dander")).toBe("cat");
    expect(allergenKey("Penicillin allergy")).toBe("penicillin");
  });

  const stored: StoredAllergyInput[] = [
    {
      id: 1,
      substance: "Penicillin",
      reaction: "Hives",
      severity: "Moderate",
      status: "active",
      onsetDate: "2020-01-01",
      source: null,
      documentId: null,
    },
    {
      id: 2,
      substance: "Peanut",
      reaction: null,
      severity: null,
      status: "active",
      onsetDate: null,
      source: null,
      documentId: null,
    },
  ];
  const sens: IgESensitizationInput[] = [
    {
      allergen: "Peanut",
      marker: "Peanut IgE",
      value: "Class 3",
      valueNum: null,
      unit: null,
      rastClass: 3,
      flag: "high",
      date: "2023-05-01",
    },
    {
      allergen: "Cat Dander",
      marker: "Cat Dander IgE",
      value: "Class 2",
      valueNum: null,
      unit: null,
      rastClass: 2,
      flag: "high",
      date: "2023-05-01",
    },
  ];

  it("merges documented + lab-derived, dedup by allergen", () => {
    const view = buildAllergiesView(stored, sens);
    // Penicillin (documented only), Peanut (both), Cat Dander (labs only) = 3 rows.
    expect(view.length).toBe(3);
    const peanut = view.find((v) => v.key === "peanut")!;
    expect(peanut.documented).toBe(true);
    expect(peanut.origin).toBe("both");
    expect(peanut.evidence?.rastClass).toBe(3);
    const cat = view.find((v) => v.key === "cat")!;
    expect(cat.documented).toBe(false);
    expect(cat.origin).toBe("labs");
    const pen = view.find((v) => v.key === "penicillin")!;
    expect(pen.origin).toBe("documented");
    expect(pen.evidence).toBe(null);
  });

  it("documented rows sort before lab-only", () => {
    const view = buildAllergiesView(stored, sens);
    expect(view[view.length - 1].origin).toBe("labs");
    expect(view[0].documented).toBe(true);
  });
});
