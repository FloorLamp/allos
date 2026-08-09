import { describe, it, expect } from "vitest";
import {
  normalizeCanonicalKey,
  buildCanonicalIndex,
  claimCanonicalKey,
  snapCanonicalName,
  snapCanonicalNameIntoBatch,
  vitaminDIsoform,
  distinguishVitaminDIsoform,
  vitaminDRetestFamily,
  VITAMIN_D_25OH_FAMILY,
  HEMOGLOBIN_A1C_FAMILY,
  BIOMARKER_FAMILIES,
  biomarkerFamily,
  biomarkerFamilyAnchor,
  biomarkerRetestIdentity,
  canonicalAliases,
  uncuratedAnalyte,
  uncuratedAnalytes,
  isGarbageCanonical,
} from "../canonical-name";
import canonicalSeed from "../canonical-biomarkers.json";

describe("normalizeCanonicalKey", () => {
  it("is case-, punctuation- and order-insensitive", () => {
    expect(normalizeCanonicalKey("LDL Cholesterol")).toBe(
      normalizeCanonicalKey("ldl  cholesterol")
    );
    expect(normalizeCanonicalKey("Creatinine, Urine")).toBe(
      normalizeCanonicalKey("Urine Creatinine")
    );
  });

  it("expands 25-OH to 25-hydroxy in its various spellings", () => {
    const target = normalizeCanonicalKey("Vitamin D, 25-Hydroxy");
    expect(normalizeCanonicalKey("25-OH Vitamin D")).toBe(target);
    expect(normalizeCanonicalKey("25 OH Vitamin D")).toBe(target);
    expect(normalizeCanonicalKey("25OH Vitamin D")).toBe(target);
    expect(normalizeCanonicalKey("Vitamin D, 25-OH")).toBe(target);
  });

  it("keeps a different measurement distinct", () => {
    // Specimen qualifier changes WHAT is measured -> different key.
    expect(normalizeCanonicalKey("Creatinine")).not.toBe(
      normalizeCanonicalKey("Creatinine, Urine")
    );
    // 1,25-dihydroxy is the active metabolite, distinct from 25-hydroxy.
    expect(normalizeCanonicalKey("1,25-OH Vitamin D")).not.toBe(
      normalizeCanonicalKey("25-OH Vitamin D")
    );
  });
});

describe("snapCanonicalName", () => {
  const vocab = [
    "Vitamin D, 25-Hydroxy",
    "LDL Cholesterol",
    "Creatinine",
    "Creatinine, Urine",
  ];

  it("snaps a model spelling onto the matching vocabulary entry", () => {
    expect(snapCanonicalName("25-OH Vitamin D", vocab)).toBe(
      "Vitamin D, 25-Hydroxy"
    );
    // Case + comma-inversion of an existing entry.
    expect(snapCanonicalName("cholesterol, ldl", vocab)).toBe(
      "LDL Cholesterol"
    );
  });

  it("leaves a genuinely new analyte unchanged", () => {
    expect(snapCanonicalName("Lipoprotein(a)", vocab)).toBe("Lipoprotein(a)");
  });

  it("keeps a distinct specimen variant mapped to its own entry", () => {
    expect(snapCanonicalName("Urine Creatinine", vocab)).toBe(
      "Creatinine, Urine"
    );
  });

  it("accepts a prebuilt index", () => {
    const index = buildCanonicalIndex(vocab);
    expect(snapCanonicalName("25 OH Vitamin D", index)).toBe(
      "Vitamin D, 25-Hydroxy"
    );
  });
});

describe("vitaminDIsoform", () => {
  it("reads D2/D3 in an explicit vitamin-D context", () => {
    expect(vitaminDIsoform("25-OH Vitamin D2")).toBe("2");
    expect(vitaminDIsoform("25-OH Vitamin D3")).toBe("3");
    expect(vitaminDIsoform("Vitamin D 3, 25-Hydroxy")).toBe("3");
    expect(vitaminDIsoform("Vit D2")).toBe("2");
  });

  it("reads the chemical names", () => {
    expect(vitaminDIsoform("Ergocalciferol")).toBe("2");
    expect(vitaminDIsoform("25-OH Vitamin D3 (Cholecalciferol)")).toBe("3");
  });

  it("returns null for a generic or total vitamin D", () => {
    expect(vitaminDIsoform("Vitamin D, 25-Hydroxy")).toBeNull();
    expect(vitaminDIsoform("25-OH Vitamin D")).toBeNull();
    expect(vitaminDIsoform("1,25-Dihydroxy Vitamin D")).toBeNull();
  });

  it("does not misread an unrelated D2/D3 token", () => {
    // The allergen panel's "(D2)" is not a vitamin-D isoform.
    expect(vitaminDIsoform("Dermatophagoides Farinae (D2) IgE")).toBeNull();
    expect(vitaminDIsoform("Complement C3")).toBeNull();
  });
});

describe("distinguishVitaminDIsoform", () => {
  it("keeps D2 and D3 apart when the model collapses both onto the generic name", () => {
    // The model drops the D2/D3 suffix and reuses the generic vocab entry for
    // both rows; the verbatim lab name recovers the metabolite.
    const d2 = distinguishVitaminDIsoform(
      "Vitamin D, 25-Hydroxy",
      "25-OH Vitamin D2"
    );
    const d3 = distinguishVitaminDIsoform(
      "Vitamin D, 25-Hydroxy",
      "25-OH Vitamin D3"
    );
    expect(d2).toBe("Vitamin D2, 25-Hydroxy");
    expect(d3).toBe("Vitamin D3, 25-Hydroxy");
    expect(normalizeCanonicalKey(d2)).not.toBe(normalizeCanonicalKey(d3));
  });

  it("re-attaches the isoform to a plain/total generic name", () => {
    expect(distinguishVitaminDIsoform("Vitamin D", "Vitamin D3")).toBe(
      "Vitamin D3"
    );
    expect(
      distinguishVitaminDIsoform("Vitamin D, Total", "Ergocalciferol")
    ).toBe("Vitamin D2");
  });

  it("leaves an already isoform-specific canonical name unchanged", () => {
    expect(
      distinguishVitaminDIsoform("Vitamin D3, 25-Hydroxy", "25-OH Vitamin D3")
    ).toBe("Vitamin D3, 25-Hydroxy");
  });

  it("leaves a generic total vitamin D alone", () => {
    expect(
      distinguishVitaminDIsoform("Vitamin D, 25-Hydroxy", "25-OH Vitamin D")
    ).toBe("Vitamin D, 25-Hydroxy");
  });

  it("does not touch a non-vitamin-D name", () => {
    expect(distinguishVitaminDIsoform("Creatinine", "Creatinine, Serum")).toBe(
      "Creatinine"
    );
  });
});

describe("vitaminDRetestFamily", () => {
  it("collapses the 25-hydroxy vitamin-D variants onto one family key", () => {
    for (const name of [
      "Vitamin D, 25-Hydroxy",
      "Vitamin D, Total",
      "Vitamin D",
      "25-OH Vitamin D",
      "Vitamin D2, 25-Hydroxy",
      "Vitamin D3, 25-Hydroxy",
      "Vit D2",
      "Ergocalciferol",
      "25-OH Vitamin D3 (Cholecalciferol)",
    ]) {
      expect(vitaminDRetestFamily(name)).toBe(VITAMIN_D_25OH_FAMILY);
    }
  });

  it("keeps distinct vitamin-D analytes out of the storage-form family", () => {
    // Active metabolite (calcitriol) — a separate test.
    expect(vitaminDRetestFamily("1,25-Dihydroxy Vitamin D")).toBeNull();
    expect(vitaminDRetestFamily("Vitamin D, 1,25-Dihydroxy")).toBeNull();
    expect(vitaminDRetestFamily("Calcitriol")).toBeNull();
    // Binding protein / receptor are not the 25-OH status measurement.
    expect(vitaminDRetestFamily("Vitamin D Binding Protein")).toBeNull();
    expect(vitaminDRetestFamily("Vitamin D Receptor")).toBeNull();
  });

  it("returns null for a non-vitamin-D name or empty input", () => {
    expect(vitaminDRetestFamily("LDL Cholesterol")).toBeNull();
    expect(
      vitaminDRetestFamily("Dermatophagoides Farinae (D2) IgE")
    ).toBeNull();
    expect(vitaminDRetestFamily(null)).toBeNull();
    expect(vitaminDRetestFamily("")).toBeNull();
  });
});

describe("biomarkerFamily (unified identity — #482)", () => {
  const VITD_KEY = `family:${VITAMIN_D_25OH_FAMILY}`;
  const A1C_KEY = `family:${HEMOGLOBIN_A1C_FAMILY}`;

  it("collapses the TOTAL 25-hydroxy vitamin-D spellings onto ONE identity", () => {
    // The TOTAL storage-marker spellings share the family identity…
    for (const name of [
      "Vitamin D, 25-Hydroxy",
      "Vitamin D, Total",
      "Vitamin D",
      "25-OH Vitamin D",
    ]) {
      expect(biomarkerFamily(name)).toBe(VITD_KEY);
    }
  });

  it("gives each D2/D3 fraction its OWN identity, apart from the total (#1193)", () => {
    // …but the D2/D3 fractions are DISTINCT analytes — each its own trendable series
    // that flags independently and must NOT dedup/is_latest against the total (the
    // #482 over-collapse #1193 fixes). biomarkerFamily returns each fraction's own
    // singleton identity, never the family key.
    for (const name of [
      "Vitamin D2, 25-Hydroxy",
      "Vitamin D3, 25-Hydroxy",
      "Vit D2",
      "Ergocalciferol",
      "25-OH Vitamin D3 (Cholecalciferol)",
    ]) {
      expect(biomarkerFamily(name)).not.toBe(VITD_KEY);
    }
    // They stay distinct from each other and from the total too.
    expect(biomarkerFamily("Vitamin D2, 25-Hydroxy")).not.toBe(
      biomarkerFamily("Vitamin D3, 25-Hydroxy")
    );
    // But the BROAD retest clock still binds total + D2 + D3 into one family, so a
    // fresh total supersedes an old fraction's redraw (biomarkerRetestIdentity).
    for (const name of [
      "Vitamin D, 25-Hydroxy",
      "Vitamin D2, 25-Hydroxy",
      "Vitamin D3, 25-Hydroxy",
      "Ergocalciferol",
    ]) {
      expect(biomarkerRetestIdentity(name)).toBe(VITD_KEY);
    }
  });

  it("collapses A1c and its eAG re-expression onto ONE identity (the D2/D3 case)", () => {
    for (const name of [
      "Hemoglobin A1c",
      "HbA1c",
      "A1c",
      "Glycated Hemoglobin",
      "Glycohemoglobin",
      "Estimated Average Glucose",
      "eAG",
    ]) {
      expect(biomarkerFamily(name)).toBe(A1C_KEY);
    }
  });

  it("holds distinct assays / fractions / specimens / metabolites APART (#481 exclusion discipline)", () => {
    // Active metabolite vs the 25-OH storage form.
    expect(biomarkerFamily("1,25-Dihydroxy Vitamin D")).not.toBe(VITD_KEY);
    expect(biomarkerFamily("Calcitriol")).not.toBe(VITD_KEY);
    expect(biomarkerFamily("Vitamin D, 1,25-Dihydroxy")).not.toBe(VITD_KEY);
    // The active metabolite is excluded even from the BROAD retest family (#1193).
    expect(biomarkerRetestIdentity("Vitamin D, 1,25-Dihydroxy")).not.toBe(
      VITD_KEY
    );
    expect(biomarkerRetestIdentity("Calcitriol")).not.toBe(VITD_KEY);
    // The D2/D3 FRACTIONS keep their own identity — never folded onto the total —
    // so a flagged D3 can't be masked by a normal total (#1193).
    expect(biomarkerFamily("Vitamin D2, 25-Hydroxy")).not.toBe(VITD_KEY);
    expect(biomarkerFamily("Vitamin D3, 25-Hydroxy")).not.toBe(VITD_KEY);
    // Binding protein / receptor are not the status measurement.
    expect(biomarkerFamily("Vitamin D Binding Protein")).not.toBe(VITD_KEY);
    // A plain fasting/random Glucose is NOT the A1c/eAG family — over-collapsing it
    // would grant a wrong retest pass (the inverse of the FIT-vs-colonoscopy audit).
    expect(biomarkerFamily("Glucose")).not.toBe(A1C_KEY);
    expect(biomarkerFamily("Fasting Glucose")).not.toBe(A1C_KEY);
    // Distinct assays / fractions stay on their own identity.
    expect(biomarkerFamily("CRP")).not.toBe(
      biomarkerFamily("High-Sensitivity C-Reactive Protein (hs-CRP)")
    );
    expect(biomarkerFamily("Testosterone, Free")).not.toBe(
      biomarkerFamily("Testosterone, Total")
    );
  });

  it("gives a non-family analyte its own singleton identity (its own name)", () => {
    expect(biomarkerFamily("LDL Cholesterol")).toBe("LDL Cholesterol");
    expect(biomarkerFamily("  LDL Cholesterol  ")).toBe("LDL Cholesterol");
    expect(biomarkerFamily("")).toBe("");
    expect(biomarkerFamily(null)).toBe("");
  });

  it("every SQL-preimage member resolves to its own family (JS ↔ SQL parity)", () => {
    // The medical.ts biomarkerFamilyKey() CASE inlines these member strings as its
    // IN(...) preimage; this pins that biomarkerFamily() (the JS half) agrees on
    // every one, so the finite-preimage SQL and the JS matcher can't drift.
    for (const fam of BIOMARKER_FAMILIES) {
      for (const member of fam.members) {
        expect(biomarkerFamily(member)).toBe(`family:${fam.key}`);
      }
    }
  });

  it("names every family by its ANCHOR, whichever member is newest (#1394/#1395)", () => {
    // The label / curated-rule key must not drift with which member happens to be a
    // profile's newest reading: an eAG-representative A1c family still resolves to
    // "Hemoglobin A1c", which is what the diabetes risk rule matches on.
    for (const name of [
      "Hemoglobin A1c",
      "HbA1c",
      "Estimated Average Glucose",
      "eAG",
      "HbA1c (Whole Blood)",
    ]) {
      expect(biomarkerFamilyAnchor(name)).toBe("Hemoglobin A1c");
    }
    for (const name of [
      "Vitamin D, 25-Hydroxy",
      "Vitamin D",
      "Vitamin D, Total",
      "25-OH Vitamin D",
    ]) {
      expect(biomarkerFamilyAnchor(name)).toBe("Vitamin D, 25-Hydroxy");
    }
    // Keyed on the IDENTITY family, NOT the wider retest clock: a D2/D3 fraction is
    // its OWN series with its own band, so it keeps its own name and its own link
    // even though it shares the total's redraw clock (#1193).
    expect(biomarkerFamilyAnchor("Vitamin D3, 25-Hydroxy")).toBe(
      "Vitamin D3, 25-Hydroxy"
    );
    // A non-family analyte is its own anchor (trimmed), so this is a no-op for it.
    expect(biomarkerFamilyAnchor("  LDL Cholesterol  ")).toBe(
      "LDL Cholesterol"
    );
    expect(biomarkerFamilyAnchor("")).toBe("");
    expect(biomarkerFamilyAnchor(null)).toBe("");
  });

  it("every family anchor is a real dataset name inside its own family", () => {
    const vocab = new Set(
      (canonicalSeed as { biomarkers: { name: string }[] }).biomarkers.map(
        (b) => b.name.toLowerCase()
      )
    );
    for (const fam of BIOMARKER_FAMILIES) {
      expect(vocab.has(fam.anchor.toLowerCase())).toBe(true);
      expect(biomarkerFamily(fam.anchor)).toBe(`family:${fam.key}`);
      expect(biomarkerFamilyAnchor(fam.anchor)).toBe(fam.anchor);
    }
  });

  it("no member string belongs to two families (families are disjoint)", () => {
    const seen = new Map<string, string>();
    for (const fam of BIOMARKER_FAMILIES) {
      for (const member of fam.members) {
        expect(seen.has(member)).toBe(false);
        seen.set(member, fam.key);
      }
    }
  });
});

describe("canonical aliases (synonym/abbreviation drift)", () => {
  // The real production vocabulary, so the alias routes are exercised against the
  // spellings the dataset actually ships.
  const vocab = (
    canonicalSeed as { biomarkers: { name: string }[] }
  ).biomarkers.map((b) => b.name);
  const index = buildCanonicalIndex(vocab);
  const rawKeys = new Set(vocab.map((n) => normalizeCanonicalKey(n)));

  it("snaps common lab spellings onto the dataset canonical name", () => {
    const expectations: [string, string][] = [
      ["HbA1c", "Hemoglobin A1c"],
      ["A1c", "Hemoglobin A1c"],
      ["Glycated Hemoglobin", "Hemoglobin A1c"],
      ["SGPT", "Alanine Aminotransferase (ALT)"],
      ["Aspartate Aminotransferase", "Aspartate Aminotransferase (AST)"],
      ["Urea Nitrogen", "Blood Urea Nitrogen (BUN)"],
      ["Thyroid Stimulating Hormone", "Thyroid-Stimulating Hormone (TSH)"],
      ["Estimated GFR", "Estimated Glomerular Filtration Rate (eGFR)"],
      ["Apolipoprotein B", "Apolipoprotein B (ApoB)"],
      ["Cobalamin", "Vitamin B12"],
      ["Folic Acid", "Folate"],
      ["Bicarbonate", "Carbon Dioxide"],
      ["Retinol", "Vitamin A (Retinol)"],
      // "Full Name (ABBREV)" entries: both the bare abbrev and the full name snap.
      ["FSH", "Follicle Stimulating Hormone (FSH)"],
      ["Follicle Stimulating Hormone", "Follicle Stimulating Hormone (FSH)"],
      ["CK", "Creatine Kinase (CK)"],
      ["Creatine Kinase", "Creatine Kinase (CK)"],
      ["SHBG", "Sex Hormone Binding Globulin (SHBG)"],
      ["Anti-TPO", "Thyroid Peroxidase Antibodies (TPOAb)"],
      // AI-extraction spellings audited in #918.
      ["Absolute Neutrophil Count", "Neutrophils, Absolute"],
      [
        "Thyroid Stimulating Hormone (TSH)",
        "Thyroid-Stimulating Hormone (TSH)",
      ],
      ["Prostate Specific Antigen (PSA)", "Prostate-Specific Antigen (PSA)"],
      ["Micronutrient, Vitamin B12", "Vitamin B12"],
      // The D2/D3 print forms now route to their OWN fraction entries (#1193),
      // never folded onto the total.
      ["25-OH Vitamin D3", "Vitamin D3, 25-Hydroxy"],
      ["25-Hydroxyvitamin D2", "Vitamin D2, 25-Hydroxy"],
      // Plain CRP resolves to its own entry; LDL-C and the Absolute Lymphocyte
      // Count spelling snap onto the real entries (#1195).
      ["CRP", "C-Reactive Protein"],
      ["LDL-C", "LDL Cholesterol"],
      ["Absolute Lymphocyte Count", "Lymphocytes, Absolute"],
    ];
    for (const [spelling, canonical] of expectations) {
      expect(snapCanonicalName(spelling, index)).toBe(canonical);
    }
  });

  it("does NOT alias the free-PSA percent (it would swallow the free-absolute assay)", () => {
    // normalizeCanonicalKey strips "%", so "PSA, Free %" and "PSA, Free" share the
    // key {free, psa}. An alias for the percent would also capture the distinct
    // free-ABSOLUTE assay (ng/mL) and mis-group it. Both stay unresolved (surfaced by
    // the debugger) rather than one confidently mis-routed — the audit found the
    // absolute present alongside the percent (#918).
    expect(snapCanonicalName("PSA, Free", index)).not.toBe(
      "Prostate Specific Antigen (PSA), Free %"
    );
    expect(snapCanonicalName("PSA, Free %", index)).not.toBe(
      "Prostate Specific Antigen (PSA), Free %"
    );
  });

  it("routes the differential ABSOLUTE-count spellings to cells/uL entries, not the % ones", () => {
    // Since #2335 EVERY differential member states its measure, so the count entry is
    // always "…, Absolute" and the percentage always "…, Relative". A wrong route
    // mis-groups a cells/uL value onto a % series (#549/#482), so pin the direction —
    // for the prefixed "Absolute X Count" print form (a curated route) and for the
    // bare-plural "Absolute X" (which the ", Absolute" entry claims by token set, so
    // no curated row is needed and none exists).
    for (const [spelling, count] of [
      ["Absolute Neutrophil Count", "Neutrophils, Absolute"],
      ["Absolute Lymphocyte Count", "Lymphocytes, Absolute"],
      ["Absolute Monocyte Count", "Monocytes, Absolute"],
      ["Absolute Eosinophil Count", "Eosinophils, Absolute"],
      ["Absolute Basophil Count", "Basophils, Absolute"],
      ["Absolute Monocytes", "Monocytes, Absolute"],
      ["Absolute Eosinophils", "Eosinophils, Absolute"],
      ["Absolute Basophils", "Basophils, Absolute"],
    ] as const) {
      expect(snapCanonicalName(spelling, index)).toBe(count);
      expect(snapCanonicalName(spelling, index)).not.toBe(
        count.replace(", Absolute", ", Relative")
      );
    }
  });

  it("routes each 25-OH vitamin-D fraction to its OWN entry, apart from the total and the parent (#1193)", () => {
    // The isoform-suffixed print forms resolve to their OWN fraction entry, never
    // folded onto the total (a low D2 must not inherit the total's sufficiency band).
    expect(snapCanonicalName("25-OH Vitamin D3", index)).toBe(
      "Vitamin D3, 25-Hydroxy"
    );
    expect(snapCanonicalName("25-Hydroxyvitamin D3", index)).toBe(
      "Vitamin D3, 25-Hydroxy"
    );
    expect(snapCanonicalName("25-OH Vitamin D2", index)).toBe(
      "Vitamin D2, 25-Hydroxy"
    );
    expect(snapCanonicalName("25-Hydroxyvitamin D2", index)).toBe(
      "Vitamin D2, 25-Hydroxy"
    );
    // …and stay APART from the total 25-OH entry.
    expect(snapCanonicalName("25-OH Vitamin D3", index)).not.toBe(
      "Vitamin D, 25-Hydroxy"
    );
    // Bare "Vitamin D3" is cholecalciferol (the parent) — a distinct analyte that
    // must NOT be merged into its 25-hydroxy metabolite.
    expect(snapCanonicalName("Vitamin D3", index)).not.toBe(
      "Vitamin D3, 25-Hydroxy"
    );
    expect(snapCanonicalName("Vitamin D3", index)).not.toBe(
      "Vitamin D, 25-Hydroxy"
    );
  });

  it("resolves the calcitriol (1,25-dihydroxy) spellings to the new active-metabolite entry (#1193)", () => {
    for (const spelling of [
      "1,25-OH Vitamin D",
      "1,25-Dihydroxyvitamin D",
      "Calcitriol",
    ]) {
      expect(snapCanonicalName(spelling, index)).toBe(
        "Vitamin D, 1,25-Dihydroxy"
      );
    }
    // The active hormone is NEVER the 25-OH storage form.
    expect(snapCanonicalName("Calcitriol", index)).not.toBe(
      "Vitamin D, 25-Hydroxy"
    );
  });

  it("adds the plain-CRP / fasting-glucose / LDL-C / lymphocyte gap routes (#1195)", () => {
    // Plain CRP → its OWN entry, never hs-CRP.
    expect(snapCanonicalName("CRP", index)).toBe("C-Reactive Protein");
    expect(snapCanonicalName("C-Reactive Protein", index)).toBe(
      "C-Reactive Protein"
    );
    expect(snapCanonicalName("CRP", index)).not.toBe(
      "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
    // Fasting glucose keeps its own identity, apart from a random Glucose.
    expect(snapCanonicalName("Glucose, Fasting", index)).toBe(
      "Glucose, Fasting"
    );
    expect(snapCanonicalName("Fasting Glucose", index)).toBe(
      "Glucose, Fasting"
    );
    expect(snapCanonicalName("Glucose, Fasting", index)).not.toBe("Glucose");
    // The LDL-C abbreviation + calculated drift snap onto LDL Cholesterol.
    for (const spelling of [
      "LDL-C",
      "LDL Calculated",
      "LDL Cholesterol, Calculated",
    ]) {
      expect(snapCanonicalName(spelling, index)).toBe("LDL Cholesterol");
    }
    // Absolute Lymphocyte Count now resolves like its neutrophil sibling.
    expect(snapCanonicalName("Absolute Lymphocyte Count", index)).toBe(
      "Lymphocytes, Absolute"
    );
    expect(snapCanonicalName("Absolute Lymphocytes", index)).toBe(
      "Lymphocytes, Absolute"
    );
  });

  it("keeps genuinely distinct assays apart (no over-merging)", () => {
    // Plain CRP is a different assay than hs-CRP — must not alias onto it.
    expect(snapCanonicalName("CRP", index)).not.toBe(
      "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
    expect(snapCanonicalName("C-Reactive Protein", index)).not.toBe(
      "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
    // Free testosterone stays on its own series — the aliases never route a
    // fraction onto the total (it snaps to the free entry by word order, not total).
    expect(snapCanonicalName("Free Testosterone", index)).toBe(
      "Testosterone, Free"
    );
    expect(snapCanonicalName("Testosterone, Free", index)).not.toBe(
      "Testosterone, Total"
    );
  });

  it("routes the curated urinalysis + immunoglobulin gaps (#918), keeping urine apart from serum", () => {
    // Immunoglobulin abbreviations snap onto the full canonical entries.
    expect(snapCanonicalName("IgG", index)).toBe("Immunoglobulin G");
    expect(snapCanonicalName("IgA", index)).toBe("Immunoglobulin A");
    expect(snapCanonicalName("IgM", index)).toBe("Immunoglobulin M");
    expect(snapCanonicalName("IgG4", index)).toBe(
      "Immunoglobulin G Subclass 4"
    );
    // Urine dipstick entries resolve from "Urine X" / "X, Urine" by word order…
    expect(snapCanonicalName("Urine Glucose", index)).toBe("Glucose, Urine");
    expect(snapCanonicalName("Urine Protein", index)).toBe("Protein, Urine");
    // …and STAY APART from their serum namesakes — the §2 trap. A bare "Glucose"
    // is serum, never the urine entry, and vice versa.
    expect(snapCanonicalName("Glucose", index)).toBe("Glucose");
    expect(snapCanonicalName("Glucose, Urine", index)).not.toBe("Glucose");
    // The always-urine pads are specimen-qualified to match the extractor's spelling
    // ("Nitrite, Urine", not bare "Nitrite"); a bare or "Occult Blood" form still
    // routes there.
    expect(snapCanonicalName("Nitrite, Urine", index)).toBe("Nitrite, Urine");
    expect(snapCanonicalName("Leukocyte Esterase, Urine", index)).toBe(
      "Leukocyte Esterase, Urine"
    );
    expect(snapCanonicalName("Urobilinogen, Urine", index)).toBe(
      "Urobilinogen, Urine"
    );
    expect(snapCanonicalName("Nitrite", index)).toBe("Nitrite, Urine");
    expect(snapCanonicalName("Occult Blood, Urine", index)).toBe(
      "Blood, Urine"
    );
  });

  it("routes the off-list names a FRESH re-extraction coined, and leaves the ambiguous ones alone", () => {
    // A fresh model run, given the same vocabulary, still drifted (#918): CBC counts
    // print as bare abbrevs; specific gravity is always urine. The neutrophil %-form
    // no longer needs a route — since #2335 the entry IS "Neutrophils, Relative", so
    // both spellings land on it by token set.
    expect(snapCanonicalName("Neutrophils Relative", index)).toBe(
      "Neutrophils, Relative"
    );
    expect(snapCanonicalName("Neutrophils, Relative", index)).toBe(
      "Neutrophils, Relative"
    );
    expect(snapCanonicalName("WBC", index)).toBe("White Blood Cell Count");
    expect(snapCanonicalName("RBC", index)).toBe("Red Blood Cell Count");
    expect(snapCanonicalName("Specific Gravity", index)).toBe(
      "Urine Specific Gravity"
    );
    // Deliberately NOT aliased — resolving these would mis-route:
    // bare "pH" is specimen-ambiguous (blood-gas vs urine), and the race-specific
    // eGFR equations are DIFFERENT values that must not collapse onto one series.
    expect(snapCanonicalName("pH", index)).toBe("pH");
    expect(snapCanonicalName("eGFR, African American", index)).toBe(
      "eGFR, African American"
    );
  });

  it("resolves the audit-confirmed gap analytes and their abbreviations (#918)", () => {
    for (const [spelling, canonical] of [
      ["AFP", "Alpha-Fetoprotein (AFP)"],
      ["CEA", "Carcinoembryonic Antigen (CEA)"],
      ["HBsAg", "Hepatitis B Surface Antigen (HBsAg)"],
      ["Anti-HCV", "Hepatitis C Antibody (Anti-HCV)"],
      ["Urine Albumin", "Albumin, Urine"],
    ] as const) {
      expect(snapCanonicalName(spelling, index)).toBe(canonical);
    }
    // Urine albumin/creatinine stay APART from their serum namesakes.
    expect(snapCanonicalName("Albumin, Urine", index)).not.toBe("Albumin");
    expect(snapCanonicalName("Creatinine, Urine", index)).not.toBe(
      "Creatinine"
    );
  });

  it("flags the garbage canonical labels the model dumps rows into (#918)", () => {
    for (const g of ["Comment(S)", "comments", "See Note", "Note 1", "Results"])
      expect(isGarbageCanonical(g)).toBe(true);
    for (const real of ["Sodium", "Glucose", "Leptin", "Blood Type"])
      expect(isGarbageCanonical(real)).toBe(false);
  });

  // #2300 — the last two spelling-drift routes, and (more importantly) the names that
  // deliberately DON'T get one.
  it("routes the two urinalysis spelling-drift aliases (#2300)", () => {
    expect(snapCanonicalName("Epithelial Cells, Urine", index)).toBe(
      "Squamous Epithelial Cells, Urine"
    );
    expect(snapCanonicalName("Urine Clarity", index)).toBe("Urine Appearance");
    // Both targets are real entries the same report also prints under their own name.
    expect(snapCanonicalName("Urine Appearance", index)).toBe(
      "Urine Appearance"
    );
    expect(snapCanonicalName("Urine Color", index)).toBe("Urine Color");
  });

  // #2319 — the SINGULAR cast spellings. #2300 curated the three casts plural and
  // comma-inverted; normalizeCanonicalKey folds case, punctuation and word order but
  // NOT inflection, so the singular form a real report prints was a different key and
  // orphaned into its own band-less series beside its own curated entry.
  it("routes the singular urine-cast spellings onto their curated plural entries (#2319)", () => {
    for (const [singular, curated] of [
      ["Hyaline Cast, Urine", "Casts, Hyaline, Urine"],
      ["Granular Cast, Urine", "Casts, Granular, Urine"],
      ["RBC Cast, Urine", "Casts, RBC, Urine"],
    ] as const) {
      expect(snapCanonicalName(singular, index)).toBe(curated);
      // Word order folds on top of the route, as it does for every alias.
      expect(snapCanonicalName(`Urine ${singular.split(",")[0]}`, index)).toBe(
        curated
      );
      // The plural entry still resolves to itself — the route ADDS a spelling.
      expect(snapCanonicalName(curated, index)).toBe(curated);
    }
  });

  it("does NOT fold a trailing s globally to reach the casts (#2319)", () => {
    // Three explicit routes, deliberately not an inflection rule in the normalizer:
    // folding `s` everywhere is how two genuinely distinct analytes eventually merge.
    // The keys stay distinct; only the curated route bridges them.
    expect(normalizeCanonicalKey("Hyaline Cast, Urine")).not.toBe(
      normalizeCanonicalKey("Casts, Hyaline, Urine")
    );
    // A pair the normalizer must keep apart, proving no global rule slipped in.
    expect(normalizeCanonicalKey("Ketone")).not.toBe(
      normalizeCanonicalKey("Ketones")
    );
    // And an undeclared cast type coins its own name rather than riding a rule.
    expect(snapCanonicalName("Waxy Cast, Urine", index)).toBe(
      "Waxy Cast, Urine"
    );
  });

  it("keeps the differential's extra lines OFF their parent fraction (#2300)", () => {
    // A CBC prints these ALONGSIDE the parent %, so an alias would put two distinct
    // same-date values on one series and lose one of them.
    expect(snapCanonicalName("Atypical Lymphocytes", index)).toBe(
      "Atypical Lymphocytes"
    );
    expect(snapCanonicalName("Band Neutrophils", index)).toBe(
      "Band Neutrophils"
    );
    // The parent fractions themselves are the RETIRED bare spellings (#2335): they
    // route onto the explicit %-entry, which is a different identity from either
    // extra line above.
    expect(snapCanonicalName("Lymphocytes", index)).toBe(
      "Lymphocytes, Relative"
    );
    expect(snapCanonicalName("Neutrophils", index)).toBe(
      "Neutrophils, Relative"
    );
  });

  it("leaves ALL THREE race-branched eGFR variants unresolved (#2300)", () => {
    // Including the NON-African-American branch: it is the other side of a
    // race-ADJUSTED equation, not a race-free result, so folding it onto the
    // race-free eGFR entry would file it as one. Unresolved is what lets the
    // race-free CKD-EPI 2021 derivation fill the draw instead.
    for (const variant of [
      "eGFR, African American",
      "eGFR, Non-African-American",
      "eGFR, Thai",
    ])
      expect(snapCanonicalName(variant, index)).toBe(variant);
    expect(snapCanonicalName("Estimated GFR", index)).toBe(
      "Estimated Glomerular Filtration Rate (eGFR)"
    );
  });

  // THE ROWS #2335 DELETED, pinned against the real dataset.
  //
  // Taking the "Long Name (ABBR)" form is not cosmetic: buildCanonicalIndex derives
  // BOTH the bare abbreviation and the bare long name from such an entry, so the
  // hand-written alias rows for these spellings became redundant the moment the entry
  // was renamed, and were removed in the same change. This is the test that says the
  // coverage did not go with them — a route these names once travelled must still
  // exist, now via the derivation instead of the table.
  it("auto-derives the routes whose curated alias rows the rename made redundant", () => {
    for (const [spelling, canonical] of [
      // eGFR: the bare abbreviation, the bare long form, and the comma-inverted long
      // form ("Glomerular Filtration Rate, Estimated") — three rows, one derivation,
      // because a token set is order-independent.
      ["eGFR", "Estimated Glomerular Filtration Rate (eGFR)"],
      [
        "Estimated Glomerular Filtration Rate",
        "Estimated Glomerular Filtration Rate (eGFR)",
      ],
      [
        "Glomerular Filtration Rate, Estimated",
        "Estimated Glomerular Filtration Rate (eGFR)",
      ],
      // Spirometry.
      ["FEV1", "Forced Expiratory Volume in 1 Second (FEV1)"],
      [
        "Forced Expiratory Volume in 1 Second",
        "Forced Expiratory Volume in 1 Second (FEV1)",
      ],
      ["FVC", "Forced Vital Capacity (FVC)"],
      ["Forced Vital Capacity", "Forced Vital Capacity (FVC)"],
      // The other entries the same rename gave an acronym parenthetical — their bare
      // abbreviations were never hand-aliased and never need to be.
      ["RPR", "Rapid Plasma Reagin (RPR)"],
      ["Rapid Plasma Reagin", "Rapid Plasma Reagin (RPR)"],
      [
        "HOMA-IR",
        "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)",
      ],
      [
        "Homeostatic Model Assessment of Insulin Resistance",
        "Homeostatic Model Assessment of Insulin Resistance (HOMA-IR)",
      ],
    ] as const)
      expect(snapCanonicalName(spelling, index), spelling).toBe(canonical);

    // And the curated table really is rid of them: a row for any of these would be
    // inert (the derivation claims the key first), so leaving one behind is the
    // hand-maintenance this convention exists to delete.
    const aliasKeys = new Set(
      canonicalAliases().map(([alias]) => normalizeCanonicalKey(alias))
    );
    for (const gone of [
      "eGFR",
      "Estimated Glomerular Filtration Rate",
      "Glomerular Filtration Rate, Estimated",
      "FEV1",
      "Forced Expiratory Volume in 1 Second",
      "FVC",
      "Forced Vital Capacity",
    ])
      expect(aliasKeys.has(normalizeCanonicalKey(gone)), gone).toBe(false);
  });

  // The counterpart: a parenthetical containing a SPACE is not an acronym
  // (looksLikeAbbreviation rejects it), so these entries derive their bare long name
  // but NOT their bare print form — which is why the thyroid and ANA routes are
  // load-bearing rather than redundant, and must NOT be deleted alongside the others.
  it("keeps the curated routes the abbreviation heuristic cannot derive", () => {
    for (const [spelling, canonical] of [
      ["Free T4", "Thyroxine, Free (Free T4)"],
      ["T4, Free", "Thyroxine, Free (Free T4)"],
      ["Free T3", "Triiodothyronine, Free (Free T3)"],
      ["Total T4", "Thyroxine, Total (Total T4)"],
      ["Total T3", "Triiodothyronine, Total (Total T3)"],
      [
        "ANA Screen, IFA",
        "Antinuclear Antibody Screen, Indirect Immunofluorescence Assay (ANA IFA)",
      ],
    ] as const)
      expect(snapCanonicalName(spelling, index), spelling).toBe(canonical);

    // Bare "ANA" is deliberately NOT routed: this screen is run by INDIRECT
    // IMMUNOFLUORESCENCE, and an EIA/multiplex ANA screen is a different method with
    // different operating characteristics, so routing an unqualified "ANA" here would
    // merge two assays.
    expect(snapCanonicalName("ANA", index)).toBe("ANA");
  });

  // The issue's acceptance criterion, run over SYNTHETIC names rather than the
  // owner's corpus: every remaining unresolved analyte name resolves to a seeded
  // canonical entry — which is exactly what the AI import path's unresolved tally
  // asks (lib/import-shape: snap the model's canonical_name, then test the snapped
  // key against the seeded vocabulary) — except the five deliberate exclusions.
  it("resolves every #2300 name, and still surfaces the five deliberate exclusions", () => {
    const resolves = (name: string) =>
      rawKeys.has(normalizeCanonicalKey(snapCanonicalName(name, index)));

    const closed = [
      // §1 aliases, spelled as the drifting lab prints them.
      "Epithelial Cells, Urine",
      "Urine Clarity",
      // §2 urinalysis microscopy + physical description.
      "Urine Color",
      "Urine Appearance",
      "Bacteria, Urine",
      "Casts, Hyaline, Urine",
      "Casts, Granular, Urine",
      "Casts, RBC, Urine",
      "Crystals, Urine",
      "Crystal Amount, Urine",
      // §2 stool.
      "Fecal Occult Blood",
      "Stool Color",
      "Stool Consistency",
      "Stool Ova and Parasites",
      "Stool Red Blood Cells",
      "Stool White Blood Cells",
      // §2 CBC differential.
      "Atypical Lymphocytes",
      "Band Neutrophils",
      "Red Blood Cell Morphology",
      // §2 chemistry / renal / lipid / fatty acids.
      "Bilirubin, Indirect",
      "Microalbumin/Creatinine Ratio, Urine",
      "Protein/Creatinine Ratio, Urine",
      "HDL as % of Cholesterol",
      "Omega-6 Total",
      // §2 immunology.
      "ANA Screen, IFA",
      // Word-order / punctuation variants the normalizer already folds, exercised
      // here because they are how a report prints them.
      "Urine Bacteria",
      "Hyaline Casts, Urine",
      "Urine Crystals",
    ];
    expect(closed.filter((n) => !resolves(n))).toEqual([]);

    // …and the five that stay unresolved on purpose: the three race-branched eGFR
    // equations (§4) and the two toxicology screens, which are not biomarkers.
    const excluded = [
      "eGFR, African American",
      "eGFR, Non-African-American",
      "eGFR, Thai",
      "Beta Adrenergic Blocker Screen",
      "Diuretic Screen, Urine",
    ];
    expect(excluded.filter(resolves)).toEqual([]);
  });

  it("every alias targets a REAL dataset entry and shadows no distinct analyte", () => {
    for (const [alias, canonical] of canonicalAliases()) {
      // Target is a real seeded canonical name.
      expect(rawKeys.has(normalizeCanonicalKey(canonical))).toBe(true);
      // The alias key never collides with a DIFFERENT real analyte (a real entry
      // always wins in buildCanonicalIndex; this pins that no alias was written to
      // shadow one).
      const aliasKey = normalizeCanonicalKey(alias);
      if (rawKeys.has(aliasKey)) {
        expect(normalizeCanonicalKey(canonical)).toBe(aliasKey);
      }
      // And it resolves through the production index.
      expect(snapCanonicalName(alias, index)).toBe(canonical);
    }
  });
});

describe("snapCanonicalNameIntoBatch / claimCanonicalKey (intra-batch collapse)", () => {
  it("a vocabulary miss claims its key so later same-key spellings collapse onto it", () => {
    const index = buildCanonicalIndex(["Glucose"]);
    // First spelling misses the vocabulary → kept AND claimed.
    expect(snapCanonicalNameIntoBatch("Zeta Antibody IgG", index)).toBe(
      "Zeta Antibody IgG"
    );
    // Same-key sibling later in the batch collapses onto the first occurrence.
    expect(snapCanonicalNameIntoBatch("Zeta Antibody (IgG)", index)).toBe(
      "Zeta Antibody IgG"
    );
    // A real vocabulary hit still wins over any batch claim.
    expect(snapCanonicalNameIntoBatch("glucose", index)).toBe("Glucose");
  });

  it("the batch claim never outlives its index and never rewrites an existing key", () => {
    const index = buildCanonicalIndex(["Glucose"]);
    claimCanonicalKey("Zeta Antibody IgG", index);
    claimCanonicalKey("Zeta Antibody (IgG)", index); // same key — first claim holds
    expect(snapCanonicalName("zeta antibody igg", index)).toBe(
      "Zeta Antibody IgG"
    );
    claimCanonicalKey("GLUCOSE", index); // may not hijack a vocabulary entry
    expect(snapCanonicalName("glucose", index)).toBe("Glucose");
    // A fresh index is unaffected (per-batch scope).
    expect(
      snapCanonicalName("zeta antibody igg", buildCanonicalIndex(["Glucose"]))
    ).toBe("zeta antibody igg");
  });
});

// #2313 — the deliberately-uncurated declarations. This is the COMPLETENESS GUARD
// the registry exists to have: a declaration is a promise made to a reader ("we
// decided this, here is why, here is where the quantity actually lives"), and each
// of the three assertions below pins one way that promise can quietly become false.
describe("deliberately uncurated analytes (#2313)", () => {
  // The real production vocabulary, as the dataset ships it — the same set a
  // curated entry is judged against everywhere else in this file.
  const vocabulary = (
    canonicalSeed as { biomarkers: { name: string }[] }
  ).biomarkers.map((b) => b.name);
  const curatedKeys = new Set(vocabulary.map((n) => normalizeCanonicalKey(n)));

  it("declares a non-empty reason for every entry", () => {
    // The MetricKnowledge `{ source: "none"; reason }` rule: the reason is what a
    // user reads instead of "unresolved", so a blank one is a silent regression to
    // the state this registry replaced.
    for (const [name, declaration] of uncuratedAnalytes()) {
      expect(declaration.reason.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("points every covered-elsewhere entry at a REAL curated entry", () => {
    // A dangling `instead` promises a series that doesn't exist — the UI links to
    // it, so the reader lands on nothing.
    for (const [name, declaration] of uncuratedAnalytes()) {
      if (declaration.kind !== "covered-elsewhere") continue;
      expect(
        curatedKeys.has(normalizeCanonicalKey(declaration.instead)),
        name
      ).toBe(true);
    }
  });

  it("declares no name that is also curated or aliased", () => {
    // Declaring AND curating the same analyte is a contradiction that would
    // otherwise resolve by whichever path ran last: the vocabulary would snap the
    // name onto a real series while this registry insisted it has none.
    const aliasKeys = new Set(
      canonicalAliases().map(([alias]) => normalizeCanonicalKey(alias))
    );
    for (const [name] of uncuratedAnalytes()) {
      const key = normalizeCanonicalKey(name);
      expect(curatedKeys.has(key), name).toBe(false);
      expect(aliasKeys.has(key), name).toBe(false);
    }
  });

  it("looks a declaration up by normalized key, so spelling variants collapse", () => {
    const egfr = uncuratedAnalyte("eGFR, African American");
    expect(egfr?.kind).toBe("covered-elsewhere");
    // The curated name since #2335 — `instead` must resolve against the dataset,
    // so it moved with the rename rather than staying on the retired spelling.
    expect(egfr && egfr.kind === "covered-elsewhere" && egfr.instead).toBe(
      "Estimated Glomerular Filtration Rate (eGFR)"
    );
    // Casing, punctuation and word order all fold — the alias table's key rule.
    expect(uncuratedAnalyte("african american egfr")).toBe(egfr);
    expect(uncuratedAnalyte("eGFR (African American)")).toBe(egfr);
    // The three race-branched equations are ONE decision.
    expect(uncuratedAnalyte("eGFR, Thai")).toBe(egfr);
    expect(uncuratedAnalyte("eGFR, Non-African-American")).toBe(egfr);
    // The tox screens are the other shape: nothing to point at.
    expect(uncuratedAnalyte("Diuretic Screen, Urine")?.kind).toBe(
      "out-of-scope"
    );
  });

  it("declares nothing about a name it has no opinion on", () => {
    // The null answer is load-bearing: it is what keeps a genuine gap actionable.
    for (const undeclared of ["eGFR", "Glucose", "E2E Novel Marker", "", "   "])
      expect(uncuratedAnalyte(undeclared)).toBeNull();
    expect(uncuratedAnalyte(null)).toBeNull();
    expect(uncuratedAnalyte(undefined)).toBeNull();
  });

  // #2319 — the DEXA regional decomposition, the family that carries the volume.
  it("declares the DEXA regional decomposition out of scope (#2319)", () => {
    const declared = [
      // Per-region fat, in the comma-inverted form and the word order a report uses.
      "Body Fat Percentage, Left Arm",
      "Body Fat Percentage, Android",
      "Right Leg Body Fat Percentage",
      // Per-site bone density and mineral content.
      "Bone Mineral Density, Lumbar Spine",
      "Bone Mineral Content, Pelvis",
      "Bone Mineral Density Z-Score",
      // The compartment-mass grid, with and without the gram suffix a report prints
      // inside the name (normalizeCanonicalKey keeps "(g)" as a token, so the two
      // spellings are different keys and both are declared).
      "Trunk Fat Mass",
      "Trunk Fat Mass (g)",
      "Subtotal Lean Mass (g)",
      "Total Mass (g)",
      // The derived depot ratios and mass indices.
      "Android/Gynoid Ratio",
      "Trunk to Legs Fat Ratio",
      "Fat Mass Index",
      "Lean Mass Index",
    ];
    for (const name of declared) {
      const d = uncuratedAnalyte(name);
      expect(d?.kind, name).toBe("out-of-scope");
      expect(d?.reason, name).toContain("per-region decomposition");
    }
    // ONE decision, shared by the whole family — not fifty separate opinions.
    expect(new Set(declared.map((n) => uncuratedAnalyte(n))).size).toBe(1);
  });

  it("leaves the whole-body totals a DEXA also prints CURATED (#2319)", () => {
    // The regions are declared; the totals they decompose are real curated analytes,
    // and the completeness guard above would fail if this line ever blurred. Stated
    // separately because "declare the DEXA family" is exactly the instruction someone
    // would over-apply.
    for (const total of [
      "Body Fat Percentage",
      "Bone Mineral Density T-Score",
    ]) {
      expect(uncuratedAnalyte(total), total).toBeNull();
      expect(curatedKeys.has(normalizeCanonicalKey(total)), total).toBe(true);
    }
    // And the genuine curation candidates #2322 owns stay actionable.
    for (const candidate of [
      "Waist Circumference",
      "QTc Interval",
      "Ankle-Brachial Index (ABI)",
    ])
      expect(uncuratedAnalyte(candidate), candidate).toBeNull();
  });
});
