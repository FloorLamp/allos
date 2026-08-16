import { describe, expect, it } from "vitest";
import {
  classifyReprescription,
  comparableNewStrength,
  isDoseChange,
  medFoldCandidates,
  normalizeStrength,
  pickRenewalTarget,
  type MedFoldMatch,
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

// ---- #2919: the fold escape, both legs ----

describe("comparableNewStrength", () => {
  it("leaves a bare strength alone, denominator included", () => {
    expect(comparableNewStrength("325 MG")).toBe("325 MG");
    // The bare extractor would truncate this to "2.5 MG" and break the comparison.
    expect(comparableNewStrength("2.5 MG/3ML")).toBe("2.5 MG/3ML");
  });

  it("extracts a strength out of a sig SENTENCE (the #2939 parse escape)", () => {
    expect(
      comparableNewStrength(
        "Take 1.5 mL (1.25 mg) by nebulization every 6 (six) hours if needed for wheezing."
      )
    ).toBe("1.25 mg");
  });

  it("extracts a strength packed into a drug name", () => {
    expect(comparableNewStrength("Lisinopril 10 mg")).toBe("10 mg");
  });

  it("returns null — i.e. unknown, which conservatively renews — for prose", () => {
    expect(comparableNewStrength("one tablet")).toBeNull();
    expect(comparableNewStrength(null)).toBeNull();
    expect(comparableNewStrength("  ")).toBeNull();
  });
});

function tracked(over: Partial<MedFoldMatch> = {}): MedFoldMatch {
  return {
    name: "Acetaminophen",
    brand: null,
    hasOpenCourse: false,
    strengths: [],
    ...over,
  };
}

describe("medFoldCandidates", () => {
  it("returns EVERY same-key med, not just the first", () => {
    const rows = [
      tracked({ name: "Acetaminophen 500 mg" }),
      tracked({ name: "Ibuprofen 200 mg" }),
      tracked({ name: "Acetaminophen 325 MG" }),
    ];
    expect(
      medFoldCandidates(rows, "Acetaminophen 325 MG").map((r) => r.name)
    ).toEqual(["Acetaminophen 500 mg", "Acetaminophen 325 MG"]);
  });

  it("matches on the existing row's brand too", () => {
    const rows = [tracked({ name: "Acetaminophen", brand: "Tylenol" })];
    expect(medFoldCandidates(rows, "Tylenol")).toHaveLength(1);
  });
});

describe("pickRenewalTarget", () => {
  it("skips a shadowing candidate and renews onto the identical twin", () => {
    // The observed leg 1: a legitimate MANUAL 500 mg med with an OPEN course sits at
    // a lower id than the extracted 325 MG twin. Classified alone it says "separate",
    // by the book — and used to shadow the twin on every single import.
    const shadow = tracked({
      name: "Acetaminophen 500 mg",
      hasOpenCourse: true,
      strengths: ["500 mg"],
    });
    const twin = tracked({
      name: "Acetaminophen 325 MG",
      hasOpenCourse: true,
      strengths: ["325 MG"],
    });
    expect(pickRenewalTarget([shadow, twin], "325 MG")).toBe(twin);
  });

  it("renews onto a closed-course candidate", () => {
    const closed = tracked({ hasOpenCourse: false, strengths: ["500 mg"] });
    expect(pickRenewalTarget([closed], "325 MG")).toBe(closed);
  });

  it("returns null when EVERY candidate is a concurrent second product", () => {
    // #1027's carve-out survives: no twin to renew onto means a genuine new item.
    const only = tracked({ hasOpenCourse: true, strengths: ["500 mg"] });
    expect(pickRenewalTarget([only], "325 MG")).toBeNull();
    expect(pickRenewalTarget([], "325 MG")).toBeNull();
  });
});
