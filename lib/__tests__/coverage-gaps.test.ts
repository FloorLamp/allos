import { describe, it, expect } from "vitest";
import {
  biomarkerCoverageKey,
  medicationCoverageKey,
  conditionCoverageKey,
  curatedBiomarkerFamilyKeys,
  detectBiomarkerGaps,
  isBiomarkerCovered,
  isMedicationCovered,
  isConditionCovered,
  buildCatalogRequest,
  buildEnrichPrompt,
  clampAiDescription,
  COVERAGE_ENRICH_SYSTEM,
  COVERAGE_GAP_KINDS,
} from "../coverage-gaps";

describe("coverage-gaps — identity keys", () => {
  it("folds all spellings of one biomarker family to one key", () => {
    // #482 family: every Vitamin-D / A1c spelling shares a key.
    expect(biomarkerCoverageKey("HbA1c")).toBe(
      biomarkerCoverageKey("Hemoglobin A1c")
    );
    expect(biomarkerCoverageKey("Vitamin D, 25-Hydroxy")).toBe(
      biomarkerCoverageKey("25-OH Vitamin D")
    );
  });

  it("normalizes a medication key and uppercases a condition code", () => {
    expect(medicationCoverageKey("  Ibuprofen  200mg ")).toBe(
      "ibuprofen 200mg"
    );
    expect(conditionCoverageKey("Type 2 diabetes", "e11.9")).toBe("E11.9");
    expect(conditionCoverageKey("Rare thing", null)).toBe("rare thing");
  });
});

describe("coverage-gaps — coverage predicates", () => {
  const curated = curatedBiomarkerFamilyKeys([
    "Hemoglobin A1c",
    "LDL Cholesterol",
    "Vitamin D, 25-Hydroxy",
  ]);

  it("a curated biomarker (any family spelling) is covered; an unknown one is not", () => {
    expect(isBiomarkerCovered("HbA1c", curated)).toBe(true);
    expect(isBiomarkerCovered("25-hydroxyvitamin D", curated)).toBe(true);
    expect(isBiomarkerCovered("Obscure Novel Analyte XYZ", curated)).toBe(
      false
    );
  });

  it("a catalogued medication is covered; a made-up one is not", () => {
    expect(isMedicationCovered("ibuprofen")).toBe(true);
    expect(isMedicationCovered("Zzzznotarealdrugxyz")).toBe(false);
  });

  it("a condition with a curated ICD-10 code (or resolvable name) is covered", () => {
    expect(isConditionCovered("Chronic viral hepatitis C", "B18.2")).toBe(true);
    // An uncoded name that resolves to a suggestion counts as covered.
    expect(isConditionCovered("HIV disease", null)).toBe(true);
    // A gibberish name with no code and no suggestion is a gap.
    expect(isConditionCovered("Qwerty zxcv nonsense", null)).toBe(false);
  });
});

describe("coverage-gaps — detection", () => {
  const curated = curatedBiomarkerFamilyKeys(["Hemoglobin A1c"]);

  it("returns only uncovered names, one candidate per family", () => {
    const { candidates, declined } = detectBiomarkerGaps(
      ["HbA1c", "Hemoglobin A1c", "Obscure One", "obscure one", "Another Gap"],
      curated
    );
    const labels = candidates.map((g) => g.label);
    // A1c is covered (both spellings dropped); the two "Obscure One" spellings
    // fold to one candidate; "Another Gap" is its own.
    expect(labels).toEqual(["Obscure One", "Another Gap"]);
    expect(candidates.every((g) => g.kind === "biomarker")).toBe(true);
    // Nothing here is declared, so the other half of the split is empty.
    expect(declined).toEqual([]);
  });

  // #2319 — Coverage candidacy is the SECOND consumer of #2313's registry. The
  // registry is imported unchanged: `uncuratedAnalyte` answers a question about the
  // analyte, so this surface (family keys over source='seed' names) and the import
  // debugger (isSeededCanonical on the exact name) reach the same declaration
  // without either owning a list.
  it("splits a DECLARED analyte out of candidacy while a genuine gap stays offered", () => {
    const { candidates, declined } = detectBiomarkerGaps(
      [
        "Body Fat Percentage, Left Arm", // declared: DEXA regional decomposition
        "Trunk Lean Mass (g)", // declared: the same family, gram-suffixed
        "eGFR, African American", // declared: covered-elsewhere
        "Waist Circumference", // a GENUINE curation candidate (#2322)
      ],
      curated
    );
    expect(candidates.map((c) => c.label)).toEqual(["Waist Circumference"]);
    expect(declined.map((d) => d.label)).toEqual([
      "Body Fat Percentage, Left Arm",
      "Trunk Lean Mass (g)",
      "eGFR, African American",
    ]);
    // Each declined row carries the reason — the whole point of declaring rather
    // than quietly dropping the name.
    for (const d of declined) {
      expect(d.kind).toBe("biomarker");
      expect(d.declaration.reason.trim().length).toBeGreaterThan(0);
    }
    expect(declined[0].declaration.kind).toBe("out-of-scope");
    expect(declined[2].declaration.kind).toBe("covered-elsewhere");
    // A declined item still keeps the family identity key a candidate would carry,
    // so the two lists remain a partition of one set.
    expect(declined[0].itemKey).toBe(
      biomarkerCoverageKey("Body Fat Percentage, Left Arm")
    );
  });

  it("a declaration is keyed by normalized name, not by spelling", () => {
    const { candidates, declined } = detectBiomarkerGaps(
      ["Left Arm Body Fat Percentage", "LUMBAR SPINE BONE MINERAL DENSITY"],
      curated
    );
    expect(candidates).toEqual([]);
    expect(declined).toHaveLength(2);
  });

  it("does NOT decline the curated whole-body totals a DEXA scan also prints", () => {
    // The regions are declared; the totals they decompose are real curated
    // analytes, and folding them in would be the mistake this family invites.
    const totals = curatedBiomarkerFamilyKeys([
      "Body Fat Percentage",
      "Bone Mineral Density T-Score",
    ]);
    const { candidates, declined } = detectBiomarkerGaps(
      ["Body Fat Percentage", "Bone Mineral Density T-Score"],
      totals
    );
    expect(candidates).toEqual([]);
    expect(declined).toEqual([]);
  });

  it("KINDS constant lists all three kinds", () => {
    expect([...COVERAGE_GAP_KINDS].sort()).toEqual([
      "biomarker",
      "condition",
      "medication",
    ]);
  });
});

describe("coverage-gaps — de-identified catalog request (decision B)", () => {
  it("carries only the item name/code and never leaks a value or date", () => {
    const req = buildCatalogRequest(
      "biomarker",
      "Obscure Novel Analyte",
      "obscure novel analyte"
    );
    expect(req.title).toContain("Obscure Novel Analyte");
    expect(req.body).toContain("Obscure Novel Analyte");
    // No PHI: the builder is given only a name + key, so a value/date can't appear.
    expect(req.body).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/); // no ISO date
    expect(req.issueUrl).toContain("github.com/FloorLamp/allos/issues/new");
    expect(req.issueUrl).toContain("labels=catalog-coverage");
    // The title is URL-encoded into the link.
    expect(req.issueUrl).toContain(encodeURIComponent("Obscure Novel Analyte"));
  });
});

describe("coverage-gaps — AI enrichment safety (decision A)", () => {
  it("the system prompt hard-bars ranges, thresholds, and severities", () => {
    expect(COVERAGE_ENRICH_SYSTEM).toMatch(/reference range/i);
    expect(COVERAGE_ENRICH_SYSTEM).toMatch(/threshold/i);
    expect(COVERAGE_ENRICH_SYSTEM).toMatch(/interaction/i);
    expect(COVERAGE_ENRICH_SYSTEM).toMatch(/do not/i);
  });

  it("builds a per-kind prompt and clamps a runaway description", () => {
    expect(buildEnrichPrompt("medication", "Foo")).toContain("Foo");
    expect(clampAiDescription("  hi  ")).toBe("hi");
    expect(clampAiDescription("x".repeat(5000)).length).toBe(1200);
  });
});
