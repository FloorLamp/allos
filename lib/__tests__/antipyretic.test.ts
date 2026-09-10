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
    for (const name of [
      "Ibuprofen",
      "Children's Tylenol",
      "Tylenol with Codeine",
      "Advil 200mg",
      "Advil",
      "Aspirin",
    ]) {
      expect(
        isAntipyreticIntakeItem({ name, rxcui: null }),
        `${name} should be antipyretic`
      ).toBe(true);
    }
  });

  // PRESENCE IS NOT IDENTITY, and this predicate asks presence (#5230).
  //
  // `Non-Aspirin Pain Reliever` IS acetaminophen and IS a fever reducer, and it reaches
  // the curated dataset only through the word `aspirin`. #5230's identity detector
  // composes a NEGATION GUARD on the same containment core; if that guard ever travelled
  // into this predicate's name leg, all five names below would flip to false and
  // lib/school-return-data.ts would stop counting a fever reducer as fever-masking — a
  // child cleared to return to school on a fever-free count a masking dose was hiding.
  //
  // No other test in the repository covers a negated name here: the existing coverage
  // samples Advil, Tylenol, Benadryl and Magnesium Glycinate, all of which stay green
  // through that regression. This is the writer's finding turned into a guard.
  it.each([
    "Non-Aspirin Pain Reliever",
    "Walgreens Non-Aspirin Pain Reliever, Extra Strength",
    "CVS Health Non Aspirin Pain Reliever PM",
    "Aspirin-free pain relief",
    "Cold relief without acetaminophen",
  ])(
    "still classifies a NEGATED antipyretic name as fever-masking: %s",
    (name) => {
      expect(isAntipyreticIntakeItem({ name, rxcui: null })).toBe(true);
    }
  );

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
