import { describe, expect, it } from "vitest";
import {
  classifyReprescription,
  isDoseChange,
  normalizeStrength,
} from "../medication-renewal";

describe("normalizeStrength", () => {
  it("lowercases and strips whitespace", () => {
    expect(normalizeStrength("800 MG")).toBe("800mg");
    expect(normalizeStrength("800mg")).toBe("800mg");
  });
  it("returns null for blank", () => {
    expect(normalizeStrength(null)).toBeNull();
    expect(normalizeStrength("  ")).toBeNull();
  });
});

// A strength recorded before the parser kept a concentration's denominator is
// numerator-only, and gets compared against freshly parsed strengths that keep it.
// Treating the two as different forked a duplicate item at the next refill of every
// concentration-dosed med — on every install predating the change, which is every real
// one. Fresh fixtures cannot see this by construction (it needs a row written by the
// previous build), so the asymmetry is stated directly here.
describe("numerator-only strength history (the upgraded-install case)", () => {
  const UPGRADED: [string, string, string][] = [
    ["2.5 mg", "2.5 mg/3 mL", "albuterol nebulizer solution"],
    ["400 mg", "400 mg/5 mL", "amoxicillin suspension"],
    ["100 units", "100 units/mL", "insulin glargine"],
    ["875 mg", "875 mg/125 mg", "amoxicillin-clavulanate"],
    ["125 mg", "125 mg/5 mL", "cefdinir suspension"],
  ];

  for (const [stored, incoming, product] of UPGRADED) {
    it(`${product}: stored "${stored}" renews against "${incoming}"`, () => {
      expect(
        classifyReprescription({
          existingHasOpenCourse: true,
          existingStrengths: new Set([normalizeStrength(stored)!]),
          newStrength: incoming,
        })
      ).toBe("renewal");
      // The same asymmetry drove a spurious "update the dose" prompt every refill.
      expect(isDoseChange(incoming, [stored])).toBe(false);
    });
  }

  it("does NOT fold two genuinely different concentrations", () => {
    // The tolerance is one-sided: it applies only when one side is numerator-only.
    // With a denominator on BOTH sides these are different products, and #1027's
    // concurrent carve-out must still fire.
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(["400mg/5ml"]),
        newStrength: "400 mg/10 mL",
      })
    ).toBe("separate");
    expect(isDoseChange("400 mg/10 mL", ["400 mg/5 mL"])).toBe(true);
  });

  it("does NOT fold different numerators", () => {
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(["200mg"]),
        newStrength: "800 mg",
      })
    ).toBe("separate");
  });

  it("treats a combination numerator as one strength, not a concentration", () => {
    // "5/325 mg" is hydrocodone/APAP — the slash follows a DIGIT, so there is no
    // denominator to be tolerant about and it can never match a bare "5 mg".
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(["5mg"]),
        newStrength: "5/325 mg",
      })
    ).toBe("separate");
  });
});

describe("classifyReprescription", () => {
  it("renews when the prior course is closed (a refill/re-issue)", () => {
    expect(
      classifyReprescription({
        existingHasOpenCourse: false,
        existingStrengths: new Set(["10mg"]),
        newStrength: "20 mg",
      })
    ).toBe("renewal");
  });

  it("renews an open course at the SAME strength (continuation)", () => {
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(["10mg"]),
        newStrength: "10 mg",
      })
    ).toBe("renewal");
  });

  it("keeps SEPARATE an open course at a provably DIFFERENT strength (#1027 concurrent)", () => {
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(["200mg"]),
        newStrength: "800 mg",
      })
    ).toBe("separate");
  });

  it("renews (folds) when a strength is unknown on either side — never spawn a duplicate", () => {
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(),
        newStrength: "800 mg",
      })
    ).toBe("renewal");
    expect(
      classifyReprescription({
        existingHasOpenCourse: true,
        existingStrengths: new Set(["200mg"]),
        newStrength: null,
      })
    ).toBe("renewal");
  });
});

describe("isDoseChange", () => {
  it("flags a known, different strength against a known live schedule", () => {
    expect(isDoseChange("20 mg", ["10 mg"])).toBe(true);
  });
  it("does not flag a matching strength", () => {
    expect(isDoseChange("10 mg", ["10 mg"])).toBe(false);
  });
  it("never flags when a strength is unknown on either side", () => {
    expect(isDoseChange(null, ["10 mg"])).toBe(false);
    expect(isDoseChange("10 mg", [])).toBe(false);
  });
});
