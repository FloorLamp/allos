import { describe, it, expect } from "vitest";
import {
  normalizeResultType,
  normalizeSignificance,
  normalizeZygosity,
  variantDisplayLabel,
  resultTypeLabel,
  significanceLabel,
} from "../genomic-variant";

// Pure coercion + label logic for structured genomic variants (#709). These map a
// report's raw strings onto the DB CHECK vocabularies so an import can never trip a
// constraint — the same coercion the Server Actions and the import path share.

describe("normalizeResultType", () => {
  it("maps PGx phrasings to pharmacogenomic", () => {
    for (const raw of [
      "pharmacogenomic",
      "Pharmacogenomics",
      "PGx",
      "drug-gene",
      "drug response",
      "metabolizer panel",
    ]) {
      expect(normalizeResultType(raw)).toBe("pharmacogenomic");
    }
  });

  it("maps hereditary phrasings to hereditary-risk", () => {
    for (const raw of [
      "hereditary-risk",
      "Hereditary cancer",
      "predisposition",
      "cancer risk",
    ]) {
      expect(normalizeResultType(raw)).toBe("hereditary-risk");
    }
  });

  it("recognizes carrier and diagnostic", () => {
    expect(normalizeResultType("carrier screening")).toBe("carrier");
    expect(normalizeResultType("Diagnostic")).toBe("diagnostic");
  });

  it("falls back to 'other' for unknown / absent (never routes a mystery result)", () => {
    expect(normalizeResultType(null)).toBe("other");
    expect(normalizeResultType("")).toBe("other");
    expect(normalizeResultType("wat")).toBe("other");
    expect(normalizeResultType(42)).toBe("other");
  });
});

describe("normalizeSignificance", () => {
  it("maps ACMG terms and VUS", () => {
    expect(normalizeSignificance("Pathogenic")).toBe("pathogenic");
    expect(normalizeSignificance("likely pathogenic")).toBe(
      "likely-pathogenic"
    );
    expect(normalizeSignificance("VUS")).toBe("uncertain-significance");
    expect(normalizeSignificance("Variant of uncertain significance")).toBe(
      "uncertain-significance"
    );
    expect(normalizeSignificance("likely benign")).toBe("likely-benign");
    expect(normalizeSignificance("Benign")).toBe("benign");
  });

  it("does not confuse 'likely pathogenic' for bare 'pathogenic'", () => {
    // The likely- compounds must be checked before the bare terms.
    expect(normalizeSignificance("Likely Pathogenic")).toBe(
      "likely-pathogenic"
    );
    expect(normalizeSignificance("Likely Benign")).toBe("likely-benign");
  });

  it("returns null when the report gives none", () => {
    expect(normalizeSignificance(null)).toBeNull();
    expect(normalizeSignificance("")).toBeNull();
    expect(normalizeSignificance("normal metabolizer")).toBeNull();
  });
});

describe("normalizeZygosity", () => {
  it("accepts full and short forms", () => {
    expect(normalizeZygosity("heterozygous")).toBe("heterozygous");
    expect(normalizeZygosity("Het")).toBe("heterozygous");
    expect(normalizeZygosity("homozygous")).toBe("homozygous");
    expect(normalizeZygosity("HOM")).toBe("homozygous");
    expect(normalizeZygosity("hemizygous")).toBe("hemizygous");
  });

  it("returns null for absent / unknown", () => {
    expect(normalizeZygosity(null)).toBeNull();
    expect(normalizeZygosity("mosaic")).toBeNull();
  });
});

describe("variantDisplayLabel", () => {
  const base = {
    gene: "CYP2C19",
    variant: null,
    genotype: null,
    star_allele: null,
    zygosity: null,
  };

  it("prefers star-allele, then genotype, then zygosity", () => {
    expect(variantDisplayLabel({ ...base, star_allele: "*2/*2" })).toBe(
      "CYP2C19 *2/*2"
    );
    expect(
      variantDisplayLabel({ ...base, gene: "APOE", genotype: "ε3/ε4" })
    ).toBe("APOE ε3/ε4");
    expect(
      variantDisplayLabel({
        ...base,
        gene: "F5",
        zygosity: "heterozygous",
      })
    ).toBe("F5 heterozygous");
  });

  it("falls back to the gene alone and appends the variant id", () => {
    expect(variantDisplayLabel({ ...base, gene: "BRCA1" })).toBe("BRCA1");
    expect(
      variantDisplayLabel({
        ...base,
        gene: "BRCA1",
        star_allele: null,
        variant: "c.68_69del",
      })
    ).toBe("BRCA1 (c.68_69del)");
  });
});

describe("labels", () => {
  it("labels every result type and significance without editorializing", () => {
    expect(resultTypeLabel("pharmacogenomic")).toBe("Pharmacogenomic");
    expect(resultTypeLabel("hereditary-risk")).toBe("Hereditary risk");
    expect(significanceLabel("uncertain-significance")).toBe(
      "Uncertain significance (VUS)"
    );
    // No risk / prognosis words — factual classification only.
    expect(significanceLabel("pathogenic")).toBe("Pathogenic");
  });
});
