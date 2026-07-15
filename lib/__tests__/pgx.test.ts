import { describe, expect, it } from "vitest";
import {
  statedPhenotype,
  derivedPhenotype,
  resolvePhenotype,
  crossCheckPgx,
  pgxForCandidate,
  pgxSignalKey,
  pgxTitle,
  pgxDetail,
  pgxStatusLabel,
  type PgxVariantInput,
  type PgxMedInput,
} from "@/lib/pgx";

// Pure PGx cross-check (issue #710). No DB/network. Covers the two ways a phenotype
// is resolved (stated wins, diplotype derives as fallback), the gene×drug matching,
// the required note framing, and the "one question, one computation" pin (the inline
// notice and the finding are formatters over the SAME crossCheckPgx).

function variant(
  v: Partial<PgxVariantInput> & { gene: string }
): PgxVariantInput {
  return {
    id: 1,
    gene: v.gene,
    star_allele: v.star_allele ?? null,
    genotype: v.genotype ?? null,
    variant: v.variant ?? null,
    interpretation: v.interpretation ?? null,
    notes: v.notes ?? null,
  };
}

function med(
  id: number,
  name: string,
  rxcui: string | null = null
): PgxMedInput {
  return { id, name, rxcui, rxcuiIngredients: null };
}

describe("statedPhenotype — trust the report's own words", () => {
  it("reads the metabolizer phenotype from interpretation text", () => {
    expect(
      statedPhenotype(
        variant({ gene: "CYP2C19", interpretation: "Poor metabolizer" })
      )
    ).toBe("poor");
    expect(
      statedPhenotype(
        variant({ gene: "CYP2D6", interpretation: "Ultrarapid metabolizer" })
      )
    ).toBe("ultrarapid");
    expect(
      statedPhenotype(
        variant({ gene: "CYP2D6", interpretation: "Rapid metabolizer" })
      )
    ).toBe("rapid");
    expect(
      statedPhenotype(
        variant({ gene: "CYP2C9", interpretation: "Intermediate metabolizer" })
      )
    ).toBe("intermediate");
    expect(
      statedPhenotype(
        variant({ gene: "CYP2C19", interpretation: "Normal metabolizer" })
      )
    ).toBe("normal");
  });

  it("folds SLCO1B1 decreased/poor function onto intermediate/poor", () => {
    expect(
      statedPhenotype(
        variant({ gene: "SLCO1B1", interpretation: "Decreased function" })
      )
    ).toBe("intermediate");
    expect(
      statedPhenotype(
        variant({ gene: "SLCO1B1", interpretation: "Poor function" })
      )
    ).toBe("poor");
  });

  it("returns null when no phenotype is stated", () => {
    expect(
      statedPhenotype(variant({ gene: "CYP2C19", star_allele: "*2/*2" }))
    ).toBe(null);
  });
});

describe("derivedPhenotype — diplotype fallback", () => {
  const cases: [string, string, string | null][] = [
    ["CYP2C19", "*2/*2", "poor"],
    ["CYP2C19", "*1/*2", "intermediate"],
    ["CYP2C19", "*1/*1", "normal"],
    ["CYP2C19", "*17/*17", "ultrarapid"],
    ["CYP2C19", "*1/*17", "rapid"],
    ["CYP2C19", "*2/*17", "intermediate"],
    ["CYP2C9", "*1/*3", "intermediate"],
    ["TPMT", "*3A/*3C", "poor"],
    ["CYP2C19", "*2/*99", null], // unknown allele → declines
  ];
  for (const [gene, dip, expected] of cases) {
    it(`${gene} ${dip} → ${expected}`, () => {
      expect(derivedPhenotype(variant({ gene, star_allele: dip }))).toBe(
        expected
      );
    });
  }

  it("derives from a diplotype-shaped genotype when star_allele is empty", () => {
    expect(
      derivedPhenotype(variant({ gene: "CYP2C19", genotype: "*2/*2" }))
    ).toBe("poor");
  });

  it("prefers the stated phenotype over the derived one (resolvePhenotype)", () => {
    // A diplotype that would derive "intermediate", but the report states "poor".
    const v = variant({
      gene: "CYP2C19",
      star_allele: "*1/*2",
      interpretation: "Poor metabolizer",
    });
    expect(derivedPhenotype(v)).toBe("intermediate");
    expect(resolvePhenotype(v)).toBe("poor");
  });
});

describe("crossCheckPgx — the fixture the DB-tier and surfaces share", () => {
  it("flags CYP2C19 poor metabolizer × clopidogrel with the CPIC note", () => {
    const hits = crossCheckPgx(
      [
        variant({
          id: 7,
          gene: "CYP2C19",
          star_allele: "*2/*2",
          interpretation: "Poor metabolizer",
        }),
      ],
      [med(42, "Clopidogrel")]
    );
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h.gene).toBe("CYP2C19");
    expect(h.phenotype).toBe("poor");
    expect(h.medId).toBe(42);
    expect(h.dedupeKey).toBe(pgxSignalKey(42, "CYP2C19", "poor"));
    // The required framing (issue #710): phenotype + med + CPIC guidance + guardrail.
    const detail = pgxDetail(h);
    expect(pgxTitle(h)).toBe("CYP2C19 poor metabolizer — Clopidogrel");
    expect(detail).toContain(
      "CYP2C19 poor metabolizer (on file) affects Clopidogrel"
    );
    expect(detail).toContain("CPIC guidance:");
    expect(detail).toContain(
      "Informational — discuss with your prescriber before any change; do not stop or switch a medication based on this alone."
    );
    expect(detail).toMatch(/Source: CPIC/);
  });

  it("finds nothing when the profile has no PGx variant", () => {
    expect(crossCheckPgx([], [med(42, "Clopidogrel")])).toEqual([]);
  });

  it("finds nothing for an unaffected drug", () => {
    const hits = crossCheckPgx(
      [variant({ gene: "CYP2C19", interpretation: "Poor metabolizer" })],
      [med(1, "Vitamin D"), med(2, "Lisinopril")]
    );
    expect(hits).toEqual([]);
  });

  it("finds nothing for a normal metabolizer (no actionable row)", () => {
    const hits = crossCheckPgx(
      [variant({ gene: "CYP2C19", interpretation: "Normal metabolizer" })],
      [med(42, "Clopidogrel")]
    );
    expect(hits).toEqual([]);
  });

  it("flags HLA-B*57:01 positive × abacavir as contraindicated (care-tier)", () => {
    const hits = crossCheckPgx(
      [
        variant({
          id: 9,
          gene: "HLA-B",
          star_allele: "*57:01",
          interpretation: "Positive",
        }),
      ],
      [med(5, "Abacavir")]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("contraindicated");
    expect(hits[0].phenotype).toBe(null);
    expect(pgxStatusLabel(hits[0])).toBe("positive");
    expect(pgxDetail(hits[0])).toContain("HLA-B*57:01");
  });

  it("does NOT flag a negated HLA result (a negative report is not a flag)", () => {
    const hits = crossCheckPgx(
      [
        variant({
          gene: "HLA-B",
          star_allele: "*57:01",
          interpretation: "Negative — HLA-B*57:01 not detected",
        }),
      ],
      [med(5, "Abacavir")]
    );
    expect(hits).toEqual([]);
  });

  it("matches CYP2C19 poor × SSRIs by name (sertraline)", () => {
    const hits = crossCheckPgx(
      [variant({ gene: "CYP2C19", interpretation: "Poor metabolizer" })],
      [med(3, "Sertraline")]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].medName).toBe("Sertraline");
  });

  it("orders contraindicated ahead of moderate", () => {
    const hits = crossCheckPgx(
      [
        variant({
          id: 1,
          gene: "HLA-B",
          star_allele: "*57:01",
          interpretation: "Positive",
        }),
        variant({ id: 2, gene: "CYP2C19", interpretation: "Poor metabolizer" }),
      ],
      [med(5, "Abacavir"), med(3, "Sertraline")]
    );
    expect(hits.map((h) => h.severity)).toEqual([
      "contraindicated",
      "moderate",
    ]);
  });
});

describe("one question, one computation — the inline notice == the finding", () => {
  it("pgxForCandidate returns the SAME hit crossCheckPgx does for that med", () => {
    const variants = [
      variant({
        id: 7,
        gene: "CYP2C19",
        star_allele: "*2/*2",
        interpretation: "Poor metabolizer",
      }),
    ];
    const candidate = {
      name: "Clopidogrel",
      rxcui: null,
      rxcuiIngredients: null,
    };
    const notice = pgxForCandidate(candidate, variants);
    const full = crossCheckPgx(variants, [med(0, "Clopidogrel")]);
    expect(notice).toHaveLength(1);
    // Same gene, phenotype, guidance, source, severity — the two surfaces can't disagree.
    expect(notice[0].gene).toBe(full[0].gene);
    expect(notice[0].phenotype).toBe(full[0].phenotype);
    expect(pgxDetail(notice[0])).toBe(pgxDetail(full[0]));
  });

  it("pgxForCandidate is empty for a blank name", () => {
    expect(
      pgxForCandidate({ name: "  ", rxcui: null, rxcuiIngredients: null }, [
        variant({ gene: "CYP2C19", interpretation: "Poor metabolizer" }),
      ])
    ).toEqual([]);
  });
});
