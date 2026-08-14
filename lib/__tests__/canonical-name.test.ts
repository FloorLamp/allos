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
      // "Bone Mineral Density Z-Score" sat here until #2679 and does not any more: a
      // Z-score IS an age- and sex-matched population reference, which this reason
      // denies. It is asserted with the other standardization of that density below.
      // The compartment-mass grid, with and without the gram suffix a report prints
      // inside the name (normalizeCanonicalKey keeps "(g)" as a token, so the two
      // spellings are different keys and both are declared).
      "Trunk Fat Mass",
      "Trunk Fat Mass (g)",
      "Subtotal Lean Mass (g)",
      "Total Mass (g)",
      // The derived depot ratios. The two mass INDICES left this list in #2322 —
      // they divide by height rather than by a segment and have published
      // population references, so they are curated entries now (asserted below).
      "Android/Gynoid Ratio",
      "Trunk to Legs Fat Ratio",
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
    // And the two mass INDICES #2322 promoted out of the DEXA family are curated
    // entries now — the same shape as the totals above, for the same reason: they
    // are whole-body measures with published references, not a scan's segments.
    for (const promoted of ["Fat Mass Index", "Lean Mass Index"]) {
      expect(uncuratedAnalyte(promoted), promoted).toBeNull();
      expect(curatedKeys.has(normalizeCanonicalKey(promoted)), promoted).toBe(
        true
      );
    }
    // The #2322 curations proper. `uncuratedAnalyte` is null for a CURATED name
    // exactly as it is for an unknown one — the registry only ever speaks about
    // names this repo declined — so the curated half is pinned against the dataset.
    for (const curated of [
      "QTc Interval",
      "Ankle-Brachial Index (ABI), Left",
      "Electrocardiogram (ECG) Interpretation",
    ]) {
      expect(uncuratedAnalyte(curated), curated).toBeNull();
      expect(curatedKeys.has(normalizeCanonicalKey(curated)), curated).toBe(
        true
      );
    }
  });

  // #2322 — the stress test's own vitals. The interesting property is that ONE
  // report's two halves are declined for OPPOSITE reasons, which is the case a
  // single family-wide declaration would have flattened.
  it("splits the stress test's resting and peak vitals (#2322)", () => {
    // RESTING is the resting series under a visit label, so it points at it. Each
    // side of the cuff gets its OWN target — a shared declaration would have sent
    // a diastolic reading to the systolic entry.
    const systolic = uncuratedAnalyte(
      "Stress Test Resting Blood Pressure Systolic"
    );
    const diastolic = uncuratedAnalyte(
      "Stress Test Resting Blood Pressure Diastolic"
    );
    expect(systolic?.kind).toBe("covered-elsewhere");
    expect(
      systolic && systolic.kind === "covered-elsewhere" && systolic.instead
    ).toBe("Blood Pressure Systolic");
    expect(
      diastolic && diastolic.kind === "covered-elsewhere" && diastolic.instead
    ).toBe("Blood Pressure Diastolic");
    // PEAK is not the resting series, so it has nothing to point at — pointing it
    // at the resting entry is the false promise `instead` exists to prevent. All
    // three peak names are ONE decision.
    const peak = [
      "Stress Test Maximum Blood Pressure Systolic",
      "Stress Test Maximum Blood Pressure Diastolic",
      "Stress Test Maximum Heart Rate",
    ].map((n) => uncuratedAnalyte(n));
    for (const d of peak) expect(d?.kind).toBe("out-of-scope");
    expect(new Set(peak).size).toBe(1);
    // Neither half is curated — curating either would fork the vitals series.
    for (const name of [
      "Stress Test Resting Blood Pressure Systolic",
      "Stress Test Maximum Heart Rate",
    ])
      expect(curatedKeys.has(normalizeCanonicalKey(name)), name).toBe(false);
  });

  // #2643 — THE GUARD THE COMPLETENESS CHECK CANNOT BE.
  //
  // Every other assertion in this describe walks the names the registry DECLARES and
  // checks they hold up. None of them can see a name that was never declared, so a
  // region missing from one of the three cross-product lists is invisible to them by
  // construction: `DEXA_MASS_REGIONS` shipped without the four limbs and both sibling
  // lists had them, and no test could notice.
  //
  // A list-symmetry check ("all three region lists agree") would be the WRONG guard:
  // they legitimately differ, because ribs and spine have a bone compartment and no
  // fat one, and Android/Gynoid are fat depots with no skeleton. So the guard is
  // driven from the shape a REPORT has instead — the roster of row labels one whole-
  // body DEXA prints — and asserts each is either curated or declared. That is the
  // METRIC_KNOWLEDGE completeness idiom: every name states a policy, or an explicit
  // exemption, and there is no third answer.
  //
  // SYNTHETIC: label text only, in the word orders scanners print. No values, no
  // subject, no facility — a roster of column headings, not a result.
  it("leaves no row of a whole-body DEXA roster undecided (#2643)", () => {
    const roster: string[] = [];
    // The per-region grid, in the comma-inverted spelling one common vendor prints.
    for (const region of [
      "Left Arm",
      "Right Arm",
      "Arms",
      "Left Leg",
      "Right Leg",
      "Legs",
      "Trunk",
      "Head",
      "Android",
      "Gynoid",
      "Subtotal",
    ]) {
      roster.push(`Body Fat Percentage, ${region}`);
      roster.push(`Fat Mass, ${region}`);
      roster.push(`Lean Mass, ${region}`);
      roster.push(`Total Mass, ${region}`);
    }
    // …and in the other word order, which normalizeCanonicalKey must fold onto the
    // same declaration. Both spellings appear in real exports.
    roster.push("Left Arm Fat Mass", "Right Leg Lean Mass (g)");
    // The skeletal sites.
    for (const site of [
      "Left Arm",
      "Right Arm",
      "Arms",
      "Left Ribs",
      "Right Ribs",
      "Ribs",
      "Thoracic Spine",
      "Lumbar Spine",
      "Spine",
      "Left Pelvis",
      "Right Pelvis",
      "Pelvis",
      "Left Leg",
      "Right Leg",
      "Legs",
      "Trunk",
      "Head",
      "Subtotal",
    ]) {
      roster.push(`Bone Mineral Density, ${site}`);
      roster.push(`Bone Mineral Content, ${site}`);
    }
    // The scan-level block: whole-body compartments, the totals, the depot ratios,
    // the visceral-fat trio and the height-normalized indices.
    roster.push(
      "Total Mass",
      "Total Fat Mass",
      "Total Lean Mass",
      "Bone Mineral Content, Total",
      "Bone Mineral Density, Total",
      "Bone Mineral Density Z-Score",
      "Android/Gynoid Ratio",
      "Trunk to Legs Fat Ratio",
      "Trunk to Limb Fat Mass Ratio",
      "Visceral Adipose Tissue",
      "Visceral Adipose Tissue Area",
      "Visceral Adipose Tissue Volume",
      "Body Fat Percentage",
      "Bone Mineral Density T-Score",
      "Fat Mass Index",
      "Lean Mass Index",
      "Appendicular Lean Mass Index"
    );

    const undecided = roster.filter(
      (name) =>
        !curatedKeys.has(normalizeCanonicalKey(name)) &&
        uncuratedAnalyte(name) === null
    );
    expect(
      undecided,
      "every row a DEXA prints must be curated or declared — an undecided one is a " +
        "permanent Coverage candidate for a decision this registry already made"
    ).toEqual([]);

    // The roster is not vacuously satisfied by curation: the great majority of it is
    // DECLINED, which is the decision #2319 made and #2643 finished applying.
    const declined = roster.filter((n) => uncuratedAnalyte(n) !== null);
    expect(declined.length).toBeGreaterThan(roster.length / 2);
  });

  // The two scan-level names #2643 declared as covered-elsewhere rather than folding
  // into the cross product. Both point at a REAL series, and stating that is the
  // whole difference: an out-of-scope declaration would have told a reader their
  // bone density and their visceral fat aren't tracked, when both are.
  it("points whole-body bone density and VAT-in-other-units at their series (#2643)", () => {
    const bmd = uncuratedAnalyte("Bone Mineral Density, Total");
    expect(bmd?.kind).toBe("covered-elsewhere");
    expect(bmd && bmd.kind === "covered-elsewhere" && bmd.instead).toBe(
      "Bone Mineral Density T-Score"
    );
    // Word order folds here too — a report may print "Total Bone Mineral Density".
    expect(uncuratedAnalyte("Total Bone Mineral Density")).toBe(bmd);
    // And it is NOT the per-region decision: the reason a user reads must not claim
    // whole-body bone density has no reference population (the #2322 mistake).
    expect(bmd?.reason).not.toContain("per-region decomposition");

    // VAT area and volume are ONE decision, pointing at the curated mass entry.
    const area = uncuratedAnalyte("Visceral Adipose Tissue Area");
    const volume = uncuratedAnalyte("Visceral Adipose Tissue Volume");
    expect(area?.kind).toBe("covered-elsewhere");
    expect(area).toBe(volume);
    expect(area && area.kind === "covered-elsewhere" && area.instead).toBe(
      "Visceral Adipose Tissue"
    );
    // The mass entry itself stays curated — the registry never speaks about it.
    expect(uncuratedAnalyte("Visceral Adipose Tissue")).toBeNull();
  });

  // #2679 — the THIRD standardization question about the same whole-body density, and
  // the third time DEXA_DECOMPOSITION's sentence was found false of a member.
  it("declines a bone density Z-score without denying it has a reference (#2679)", () => {
    const z = uncuratedAnalyte("Bone Mineral Density Z-Score");
    expect(z?.kind).toBe("covered-elsewhere");
    expect(z && z.kind === "covered-elsewhere" && z.instead).toBe(
      "Bone Mineral Density T-Score"
    );
    // THE DEFECT, pinned as the property rather than as a string diff: a Z-score is
    // an age- and sex-matched population reference, so the one thing its reason may
    // never do is tell the reader no population reference exists for it.
    expect(z?.reason).not.toContain("per-region decomposition");
    expect(z?.reason).not.toContain("no population reference");
    // And it says what the score actually IS, which is what makes the decline
    // informative rather than merely not-false.
    expect(z?.reason).toContain("age");

    // NOT folded into the absolute-density declaration, even though both point at the
    // T-score. DEXA_TOTAL_BMD's sentence turns on g/cm² not being comparable between
    // scanners — which is false of a Z-score, the whole point of standardizing. One
    // `instead`, two reasons.
    const total = uncuratedAnalyte("Bone Mineral Density, Total");
    expect(z).not.toBe(total);
    expect(z?.reason).not.toBe(total?.reason);

    // Word order and casing fold onto the one declaration, as everywhere else here.
    expect(uncuratedAnalyte("z-score bone mineral density")).toBe(z);
    // The T-score itself stays curated; the registry never speaks about it.
    expect(uncuratedAnalyte("Bone Mineral Density T-Score")).toBeNull();
  });

  // #2679 — THE RATCHET, and it is deliberately narrow.
  //
  // Three separate corrections (#2322, #2675, #2679) landed on ONE sentence:
  // DEXA_DECOMPOSITION's "no population reference range exists for them", applied to a
  // member it is false of. No mechanical check can decide whether a sentence of
  // clinical prose is true of an analyte, and a guard that pretended to would be the
  // #2306 shape one level up — a wrong reason made to look verified. So this checks
  // the one contradiction that IS decidable from two strings, and claims nothing more.
  //
  // WHAT IT CHECKS: a name that names a STANDARDIZED SCORE — T-score, Z-score,
  // percentile, SD score — may not be declared `out-of-scope`. Such a score exists
  // only as a comparison against a reference population; that is what the number IS,
  // not a fact about it. So "this app models nothing here" is never its shape: either
  // the underlying quantity is tracked somewhere (`covered-elsewhere`, whose `instead`
  // the guard above already pins to a real entry) or the score wants curating. It
  // reads the NAME's own grammar and never the reason's prose.
  //
  // WHAT IT WOULD HAVE CAUGHT: #2679 exactly — "Bone Mineral Density Z-Score" was an
  // out-of-scope member of the cross-product family, and this fails on it. It would
  // NOT have caught #2322 or #2675, whose names carry no score token. That is stated
  // rather than glossed, because a guard credited with more than it does is worse than
  // none. What it buys is the recurrence path that is actually open: the cross product
  // MINTS names mechanically and DEXA_SCAN_LEVEL is appended to by hand, so the next
  // "…Z-Score" row a report teaches us would inherit a sentence nobody re-reads.
  const STANDARDIZED_SCORE = /\b(?:[tz][ -]?score|percentile|sd ?score)\b/i;

  it("never declares a standardized score out-of-scope (#2679)", () => {
    // Empty today. An exemption must be WRITTEN WITH A REASON, the way every scan in
    // this repo takes its allowlist — an unreasoned one is the silence this whole
    // registry exists to replace.
    const exempt: readonly (readonly [string, string])[] = [];
    for (const [name, reason] of exempt)
      expect(reason.trim().length, name).toBeGreaterThan(0);
    const exemptKeys = new Set(
      exempt.map(([name]) => normalizeCanonicalKey(name))
    );

    const offenders = uncuratedAnalytes()
      .filter(
        ([name, d]) =>
          d.kind === "out-of-scope" &&
          STANDARDIZED_SCORE.test(name) &&
          !exemptKeys.has(normalizeCanonicalKey(name))
      )
      .map(([name]) => name);
    expect(
      offenders,
      "a T-score / Z-score / percentile IS a population comparison, so it cannot be " +
        "out of scope: point it at the series carrying the measurement, or curate it"
    ).toEqual([]);
  });

  it("pins what that guard can see (#2679)", () => {
    // The regex is the guard's entire reach, so the reach is asserted rather than
    // assumed: a guard that passes by matching nothing is indistinguishable from one
    // that works, which is the failure mode it was built against.
    for (const hit of [
      "Bone Mineral Density Z-Score",
      "Bone Mineral Density T-Score",
      "Lumbar Spine BMD Z Score",
      "Height Percentile",
    ])
      expect(STANDARDIZED_SCORE.test(hit), hit).toBe(true);
    // The names it deliberately cannot judge — including the two earlier instances of
    // this defect, which is the honest limit of a name-grammar check.
    for (const miss of [
      "Bone Mineral Density, Total",
      "Fat Mass Index",
      "Lean Mass Index",
      "Android/Gynoid Ratio",
      "Total Lean Mass",
    ])
      expect(STANDARDIZED_SCORE.test(miss), miss).toBe(false);
  });

  // The limb rows the cross product was missing, asserted as ONE decision with the
  // rows that were already declared beside them — the property the bug broke.
  it("declares a limb's compartment mass exactly as its fat percentage (#2643)", () => {
    const limbRows = [
      "Fat Mass, Left Arm",
      "Lean Mass, Right Arm",
      "Total Mass, Left Leg",
      "Fat Mass, Right Leg",
      "Fat Mass, Arms",
      "Lean Mass, Legs",
      // The other word order, and the gram-suffixed print form.
      "Left Arm Fat Mass",
      "Right Leg Total Mass (g)",
    ];
    for (const name of limbRows) {
      const d = uncuratedAnalyte(name);
      expect(d?.kind, name).toBe("out-of-scope");
      expect(d?.reason, name).toContain("per-region decomposition");
    }
    // The same declaration object the limb's fat percentage and bone density carry —
    // one decision for the whole machine's table, which is what went wrong.
    expect(
      new Set([
        ...limbRows.map((n) => uncuratedAnalyte(n)),
        uncuratedAnalyte("Body Fat Percentage, Left Arm"),
        uncuratedAnalyte("Bone Mineral Density, Left Arm"),
      ]).size
    ).toBe(1);
  });
});
