import { describe, expect, it } from "vitest";
import {
  isAntipyreticIntakeItem,
  isAntipyreticEntry,
  prnDefaultsFor,
  ANTIPYRETIC_SLUGS,
} from "@/lib/prn-defaults";

// Pure tests for the antipyretic classification derived from the #798 PRN dataset
// (issue #859 item 2). No DB.

describe("antipyretic classification", () => {
  it("classifies the fever reducers as antipyretic", () => {
    for (const name of ["Ibuprofen", "Children's Tylenol", "Advil", "Aspirin"]) {
      expect(
        isAntipyreticIntakeItem({ name, rxcui: null }),
        `${name} should be antipyretic`
      ).toBe(true);
    }
  });

  it("does NOT classify a non-antipyretic PRN as a fever reducer", () => {
    // Diphenhydramine (Benadryl) is in the dataset but is an antihistamine.
    const entry = prnDefaultsFor({ name: "Benadryl", rxcui: null });
    if (entry) {
      expect(ANTIPYRETIC_SLUGS.has(entry.slug)).toBe(false);
      expect(isAntipyreticEntry(entry)).toBe(false);
    }
    expect(isAntipyreticIntakeItem({ name: "Benadryl", rxcui: null })).toBe(
      false
    );
  });

  it("does NOT classify an unrelated item", () => {
    expect(
      isAntipyreticIntakeItem({ name: "Magnesium Glycinate", rxcui: null })
    ).toBe(false);
    expect(isAntipyreticEntry(null)).toBe(false);
  });
});
