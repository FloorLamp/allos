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
