import { describe, expect, it } from "vitest";
import {
  MEDICAL_CATEGORIES,
  NON_IDENTITY_CATEGORIES,
  NON_RESULTS_CATALOG_CATEGORIES,
  RESULTS_CATALOG_CATEGORIES,
  carriesResultIdentity,
} from "@/lib/medical-categories";
import { listedInResultsCatalog } from "@/lib/trend-metric-analytes";
import {
  CANONICAL_BIOMARKERS,
  canonicalBiomarkerForName,
} from "@/lib/datasets/canonical-biomarkers";
import type { CanonicalResultDefinition } from "@/lib/types";

// The #2479 terminology contract, asserted over the REAL registry and the REAL
// predicates: docs/internals/clinical-result-terminology.md is the prose, this is
// the ratchet.
//
// The defect the issue exists to fix is that three independent axes were read as
// one, and that a fourth PROPERTY — "does this report a number?" — was proposed as
// the test for the third. It is not, and these cases are the counterexamples in
// both directions:
//
//   • non-numeric and fully identity-bearing — urine dipstick, serology, blood group
//   • numeric and identity-withheld — a screening questionnaire's ITEM answer
//
// So this file pins the axes SEPARATELY for one representative concept of each
// registry class the issue named (lab, fitness, instrument, qualitative,
// assessment) rather than asserting one composite verdict per concept.

// Catalog browsability is the CONJUNCTION of the two catalog-axis mechanisms: the
// category class, then the per-analyte #2365 refinement inside `vitals`. The row
// gather and the panel facet both compose them this way; a test that asked only
// the predicate would call PHQ-9 browsable (it is not — its category is excluded
// one level up).
function browsable(entry: CanonicalResultDefinition): boolean {
  return (
    (RESULTS_CATALOG_CATEGORIES as readonly string[]).includes(
      entry.category ?? ""
    ) && listedInResultsCatalog({ category: entry.category, name: entry.name })
  );
}

function definition(name: string): CanonicalResultDefinition {
  const entry = canonicalBiomarkerForName(name);
  if (!entry) throw new Error(`not in the canonical registry: ${name}`);
  return entry as unknown as CanonicalResultDefinition;
}

describe("the registry is a CanonicalResultDefinition set, not a biomarker set", () => {
  it("holds definitions that are neither lab nor quantities", () => {
    const nonLab = CANONICAL_BIOMARKERS.filter((e) => e.category !== "lab");
    const unitless = CANONICAL_BIOMARKERS.filter((e) => !e.unit);
    const unbanded = CANONICAL_BIOMARKERS.filter(
      (e) => e.ref_low == null && e.ref_high == null
    );
    // The numbers that ruled out CanonicalAnalyte (not all lab) and
    // CanonicalQuantity / CanonicalMeasure (not all measured).
    expect(nonLab.length).toBeGreaterThan(50);
    expect(unitless.length).toBeGreaterThan(50);
    expect(unbanded.length).toBeGreaterThan(50);
  });

  it("keeps `reference` as a category VALUE, which is why it could not be the umbrella", () => {
    expect(MEDICAL_CATEGORIES as readonly string[]).toContain("reference");
    expect(definition("ABO Blood Group").category).toBe("reference");
  });
});

describe("representative concepts, one axis at a time", () => {
  it("lab analyte: browsable and identity-bearing", () => {
    const ldl = definition("LDL Cholesterol");
    expect(ldl.category).toBe("lab");
    expect(browsable(ldl)).toBe(true);
    expect(carriesResultIdentity(ldl.category ?? "")).toBe(true);
  });

  it("fitness measure: `vitals`, browsable, identity-bearing", () => {
    // Kept browsable because nothing else answers it — the #1076 "nothing
    // stranded" rule, applied per analyte since #2365.
    const grip = definition("Grip Strength");
    expect(grip.category).toBe("vitals");
    expect(grip.unit).toBe("kg");
    expect(browsable(grip)).toBe(true);
    expect(carriesResultIdentity(grip.category ?? "")).toBe(true);
  });

  it("physiologic vital with a chart of its own: identity-bearing but NOT browsable", () => {
    // The catalog axis and the identity axis disagreeing, on purpose: blood
    // pressure is answered by /trends/metric/<slug>, and being un-listed there
    // takes nothing away from its identity.
    const systolic = definition("Blood Pressure Systolic");
    expect(systolic.category).toBe("vitals");
    expect(browsable(systolic)).toBe(false);
    expect(carriesResultIdentity(systolic.category ?? "")).toBe(true);
  });

  it("instrument score: identity-bearing but withheld from the catalog on SENSITIVITY", () => {
    const phq = definition("PHQ-9");
    expect(phq.category).toBe("instrument");
    expect(browsable(phq)).toBe(false);
    expect(NON_RESULTS_CATALOG_CATEGORIES).toContain("instrument");
    // A depression score must never surface in a general health catalog (#1076) —
    // and that is a CATALOG decision. The score still coins a canonical name and
    // still draws a series.
    expect(carriesResultIdentity(phq.category ?? "")).toBe(true);
  });

  it("qualitative results report a word and carry FULL identity", () => {
    // The bottom-left cell of the crossing table. Every one of these states no
    // number; every one is registered and identity-bearing.
    const dipstick = [
      "Protein, Urine",
      "Glucose, Urine",
      "Ketones, Urine",
      "Bilirubin, Urine",
      "Blood, Urine",
      "Nitrite, Urine",
      "Leukocyte Esterase, Urine",
    ];
    for (const name of dipstick) {
      const entry = definition(name);
      expect(entry.unit ?? null, name).toBeNull();
      expect(entry.category, name).toBe("lab");
      expect(browsable(entry), name).toBe(true);
      expect(carriesResultIdentity(entry.category ?? ""), name).toBe(true);
    }

    for (const name of [
      "Hepatitis B Surface Antigen (HBsAg)",
      "Hepatitis C Antibody (Anti-HCV)",
    ]) {
      const entry = definition(name);
      expect(entry.unit ?? null, name).toBeNull();
      expect(carriesResultIdentity(entry.category ?? ""), name).toBe(true);
    }

    // An immutable fact: registered and identity-bearing, homed in the passport
    // rather than the catalog. Two axes, two answers.
    for (const name of ["ABO Blood Group", "Rh Type", "Blood Type"]) {
      const entry = definition(name);
      expect(entry.unit ?? null, name).toBeNull();
      expect(browsable(entry), name).toBe(false);
      expect(carriesResultIdentity(entry.category ?? ""), name).toBe(true);
    }
  });

  it("assessment: the one class denied identity, and the registry never names one", () => {
    expect([...NON_IDENTITY_CATEGORIES]).toEqual(["assessment"]);
    expect(carriesResultIdentity("assessment")).toBe(false);
    expect(RESULTS_CATALOG_CATEGORIES as readonly string[]).not.toContain(
      "assessment"
    );
    // The registry is the vocabulary an identity is coined INTO, so nothing in it
    // may be an assessment — a curated `assessment` entry would be a definition
    // that no row is allowed to reference.
    expect(
      CANONICAL_BIOMARKERS.filter((e) => e.category === "assessment")
    ).toEqual([]);
  });
});

describe("quantitation is not the identity test", () => {
  it("no identity rule may be derived from the presence of a unit or a band", () => {
    // If quantitation ever became the test, these would flip together. They do
    // not: the unitless, bandless entries below are identity-bearing, and the
    // numeric questionnaire item answers stored `assessment` are not.
    const unitlessIdentityBearing = CANONICAL_BIOMARKERS.filter(
      (e) => !e.unit && carriesResultIdentity(e.category ?? "")
    );
    expect(unitlessIdentityBearing.length).toBeGreaterThan(50);

    // A screening questionnaire's ITEM answer is a number (0-3 on a PHQ-9 item)
    // and is stored in the class that denies identity, which is the reverse
    // crossing. Asserted on the category rule rather than on a fixture row: the
    // rule is what a future change would break.
    expect(carriesResultIdentity("assessment")).toBe(false);
    expect(carriesResultIdentity("instrument")).toBe(true);
  });
});
