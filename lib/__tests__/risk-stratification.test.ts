import { describe, expect, it } from "vitest";
import {
  deriveRiskFactors,
  retestModulationFor,
  screeningPriorityFor,
  screeningModulationFor,
  immunizationPriorityFor,
  visitModulationFor,
  isAnchoredOneShotReading,
  EMPTY_RISK_ATTRIBUTES,
  NO_MODULATION,
  type RiskFactor,
} from "@/lib/risk-stratification";

// Risk-stratified retest & screening priority (issue #517) — pure threshold tests.

describe("deriveRiskFactors", () => {
  it("returns an empty set for empty inputs", () => {
    expect(
      deriveRiskFactors({
        familyConditions: [],
        activeConditions: [],
        attributes: EMPTY_RISK_ATTRIBUTES,
      }).size
    ).toBe(0);
  });

  it("derives family-cardiovascular from a cardiac family-history label", () => {
    const f = deriveRiskFactors({
      familyConditions: ["Coronary artery disease", "Type 2 diabetes"],
      activeConditions: [],
      attributes: EMPTY_RISK_ATTRIBUTES,
    });
    expect(f.has("family-cardiovascular")).toBe(true);
    expect(f.has("family-diabetes")).toBe(true);
    expect(f.has("family-cancer")).toBe(false);
  });

  it("derives personal condition factors from ACTIVE conditions", () => {
    const f = deriveRiskFactors({
      familyConditions: [],
      activeConditions: ["Chronic kidney disease stage 3", "Hypertension"],
      attributes: EMPTY_RISK_ATTRIBUTES,
    });
    expect(f.has("chronic-kidney-disease")).toBe(true);
    expect(f.has("hypertension")).toBe(true);
    expect(f.has("diabetes")).toBe(false);
  });

  it("maps the occupational/immune attributes through; dialysis implies CKD", () => {
    const f = deriveRiskFactors({
      familyConditions: [],
      activeConditions: [],
      attributes: {
        healthcareWorker: true,
        immunocompromised: false,
        dialysis: true,
        pregnant: true,
        noiseExposure: false,
      },
    });
    expect([...f].sort()).toEqual(
      (
        [
          "chronic-kidney-disease",
          "dialysis",
          "healthcare-worker",
          "pregnant",
        ] as RiskFactor[]
      ).sort()
    );
  });
});

describe("retestModulationFor", () => {
  const noFactors = new Set<RiskFactor>();

  it("is a no-op when no factor matches the analyte", () => {
    expect(retestModulationFor("LDL Cholesterol", noFactors)).toEqual(
      NO_MODULATION
    );
    // A matching factor but a non-targeted analyte still no-ops.
    expect(
      retestModulationFor("Ferritin", new Set(["family-cardiovascular"]))
    ).toEqual(NO_MODULATION);
  });

  it("tightens lipid cadence + ranks up for family cardiac history", () => {
    const mod = retestModulationFor(
      "LDL Cholesterol",
      new Set(["family-cardiovascular"])
    );
    expect(mod.multiplier).toBe(0.5);
    expect(mod.priority).toBe(2);
    expect(mod.reasons).toEqual(["Family history of heart disease"]);
  });

  it("tightens hepatitis-A immunity cadence for immune/occupational factors (substring match)", () => {
    for (const factor of [
      "immunocompromised",
      "dialysis",
      "healthcare-worker",
    ] as RiskFactor[]) {
      const mod = retestModulationFor(
        "Hepatitis A IgG Antibody",
        new Set([factor])
      );
      expect(mod.multiplier).toBe(0.5);
      expect(mod.priority).toBe(1);
      expect(mod.reasons.length).toBe(1);
    }
  });

  it("tightens glucose + CBC/ferritin cadence and ranks up for pregnancy (#521)", () => {
    const pregnant = new Set<RiskFactor>(["pregnant"]);
    // Gestational-diabetes screening → glucose retested sooner + ranked up.
    const glucose = retestModulationFor("Glucose", pregnant);
    expect(glucose.multiplier).toBe(0.5);
    expect(glucose.priority).toBe(2);
    expect(glucose.reasons).toEqual([
      "Pregnancy — gestational diabetes screening",
    ]);
    // Anemia screening → CBC analytes + ferritin retested sooner.
    for (const name of ["Hemoglobin", "Hematocrit", "Ferritin"]) {
      const mod = retestModulationFor(name, pregnant);
      expect(mod.multiplier, name).toBe(0.5);
      expect(mod.priority, name).toBe(2);
      expect(mod.reasons, name).toEqual(["Pregnancy — anemia screening"]);
    }
  });

  it("does NOT modulate an uncurated pregnancy analyte (conservative curation)", () => {
    const pregnant = new Set<RiskFactor>(["pregnant"]);
    // TSH is deliberately NOT modeled (no universal thyroid-screening rec), and the
    // exact-name match must not let 'Hemoglobin' leak onto 'Hemoglobin A1c'.
    expect(retestModulationFor("TSH", pregnant)).toEqual(NO_MODULATION);
    expect(retestModulationFor("Hemoglobin A1c", pregnant)).toEqual(
      NO_MODULATION
    );
  });

  it("takes the tightest multiplier and highest priority when several rules match", () => {
    // A dialysis patient with cardiac family history: the hep-A rule (0.5/p1) and
    // the CKD rule don't overlap analytes, but stacking two immune factors on the
    // same hep-A analyte keeps the tightest of them.
    const mod = retestModulationFor(
      "Hepatitis A Antibody",
      new Set(["immunocompromised", "dialysis"])
    );
    expect(mod.multiplier).toBe(0.5);
    expect(mod.priority).toBe(1);
    // Two distinct reasons, de-duplicated & ordered by priority.
    expect(mod.reasons.length).toBe(2);
  });
});

describe("screeningPriorityFor", () => {
  it("ranks up the lipid screening for family cardiac history", () => {
    const p = screeningPriorityFor(
      "lipid_screening",
      new Set(["family-cardiovascular"])
    );
    expect(p.priority).toBe(2);
    expect(p.reasons).toEqual(["Family history of heart disease"]);
  });

  it("ranks up the diabetes screening for pregnancy (#521)", () => {
    const p = screeningPriorityFor("diabetes_screening", new Set(["pregnant"]));
    expect(p.priority).toBe(2);
    expect(p.reasons).toEqual(["Pregnancy — gestational diabetes screening"]);
  });

  it("is neutral for an unrelated screening or no matching factor", () => {
    expect(
      screeningPriorityFor(
        "colorectal_cancer",
        new Set(["family-cardiovascular"])
      )
    ).toEqual({ priority: 0, reasons: [], sourced: [] });
    expect(
      screeningPriorityFor("lipid_screening", new Set<RiskFactor>())
    ).toEqual({ priority: 0, reasons: [], sourced: [] });
  });
});

describe("immunizationPriorityFor (issue #553)", () => {
  it("ranks up pneumococcal + meningococcal for an immunocompromised / dialysis profile", () => {
    for (const factor of ["immunocompromised", "dialysis"] as RiskFactor[]) {
      const factors = new Set<RiskFactor>([factor]);
      for (const code of ["pneumo_adult", "pcv", "menacwy", "menb"]) {
        const p = immunizationPriorityFor(code, factors);
        expect(p.priority, `${factor}/${code}`).toBe(2);
        expect(p.reasons.length, `${factor}/${code}`).toBe(1);
      }
    }
  });

  it("ranks up Hep B / influenza / MMR / varicella for a healthcare worker", () => {
    const f = new Set<RiskFactor>(["healthcare-worker"]);
    for (const code of ["hepb", "influenza", "mmr", "varicella"]) {
      const p = immunizationPriorityFor(code, f);
      expect(p.priority, code).toBe(2);
      expect(p.reasons, code).toEqual(["Healthcare worker"]);
    }
  });

  it("ranks up Tdap + influenza for pregnancy", () => {
    const f = new Set<RiskFactor>(["pregnant"]);
    expect(immunizationPriorityFor("tdap", f)).toEqual({
      priority: 2,
      reasons: ["Pregnancy"],
      sourced: [{ text: "Pregnancy", source: "ACIP / ACOG (informational)" }],
    });
    expect(immunizationPriorityFor("influenza", f).priority).toBe(2);
  });

  it("adds Hep B for dialysis but NOT for a bare immunocompromised factor", () => {
    expect(
      immunizationPriorityFor("hepb", new Set<RiskFactor>(["dialysis"]))
        .priority
    ).toBe(2);
    expect(
      immunizationPriorityFor(
        "hepb",
        new Set<RiskFactor>(["immunocompromised"])
      ).priority
    ).toBe(0);
  });

  it("is neutral for an unrelated vaccine or no matching factor", () => {
    expect(
      immunizationPriorityFor("zoster", new Set<RiskFactor>(["pregnant"]))
    ).toEqual({ priority: 0, reasons: [], sourced: [] });
    expect(immunizationPriorityFor("influenza", new Set<RiskFactor>())).toEqual(
      { priority: 0, reasons: [], sourced: [] }
    );
  });

  it("does NOT bleed into the retest/screening dimensions (immunization rules are code-only)", () => {
    // An immunization-only rule must not modulate a retest or rank a screening —
    // its cadenceMultiplier/screeningRules are inert.
    const hcw = new Set<RiskFactor>(["healthcare-worker"]);
    // 'influenza' is not an analyte, but assert the retest layer stays a no-op for
    // a real analyte name under a factor whose only new rule is immunization-side.
    expect(screeningPriorityFor("lipid_screening", hcw)).toEqual({
      priority: 0,
      reasons: [],
      sourced: [],
    });
  });
});

describe("deriveRiskFactors — visit-cadence inputs (Substrate 3, #707)", () => {
  it("derives family-glaucoma from a glaucoma family-history label", () => {
    const f = deriveRiskFactors({
      familyConditions: ["Open-angle glaucoma"],
      activeConditions: [],
      attributes: EMPTY_RISK_ATTRIBUTES,
    });
    expect(f.has("family-glaucoma")).toBe(true);
  });

  it("derives current-smoking ONLY from a `current` smoking status", () => {
    const base = {
      familyConditions: [],
      activeConditions: [],
      attributes: EMPTY_RISK_ATTRIBUTES,
    };
    expect(
      deriveRiskFactors({ ...base, smokingStatus: "current" }).has(
        "current-smoking"
      )
    ).toBe(true);
    // former / never / unknown never activate it (absence is data, not a guess).
    for (const s of ["former", "never", null, undefined] as const) {
      expect(
        deriveRiskFactors({ ...base, smokingStatus: s }).has("current-smoking")
      ).toBe(false);
    }
  });

  it("derives noise-exposure from the self-declared attribute (#717)", () => {
    const f = deriveRiskFactors({
      familyConditions: [],
      activeConditions: [],
      attributes: { ...EMPTY_RISK_ATTRIBUTES, noiseExposure: true },
    });
    expect(f.has("noise-exposure")).toBe(true);
    // Absent by default.
    expect(
      deriveRiskFactors({
        familyConditions: [],
        activeConditions: [],
        attributes: EMPTY_RISK_ATTRIBUTES,
      }).has("noise-exposure")
    ).toBe(false);
  });

  it("derives ototoxic-medication only from the ototoxicMedication input (#717)", () => {
    const base = {
      familyConditions: [],
      activeConditions: [],
      attributes: EMPTY_RISK_ATTRIBUTES,
    };
    expect(
      deriveRiskFactors({ ...base, ototoxicMedication: true }).has(
        "ototoxic-medication"
      )
    ).toBe(true);
    for (const v of [false, undefined] as const) {
      expect(
        deriveRiskFactors({ ...base, ototoxicMedication: v }).has(
          "ototoxic-medication"
        )
      ).toBe(false);
    }
  });
});

describe("visitModulationFor (Substrate 3, #707)", () => {
  it("is a no-op when no factor targets the visit rule", () => {
    expect(visitModulationFor("vision_exam", new Set<RiskFactor>())).toEqual(
      NO_MODULATION
    );
    // A matching factor but a non-targeted visit rule still no-ops.
    expect(
      visitModulationFor("skin_check", new Set<RiskFactor>(["diabetes"]))
    ).toEqual(NO_MODULATION);
  });

  it("diabetes tightens vision_exam to half cadence with the ADA reason", () => {
    const mod = visitModulationFor(
      "vision_exam",
      new Set<RiskFactor>(["diabetes"])
    );
    expect(mod.multiplier).toBe(0.5);
    expect(mod.priority).toBe(2);
    expect(mod.reasons).toContain(
      "Diabetes on file — annual dilated eye exam recommended (ADA)"
    );
  });

  it("family-glaucoma brings vision_exam sooner with the AAO reason", () => {
    const mod = visitModulationFor(
      "vision_exam",
      new Set<RiskFactor>(["family-glaucoma"])
    );
    expect(mod.multiplier).toBeLessThan(1);
    expect(mod.priority).toBeGreaterThan(0);
    expect(mod.reasons).toContain(
      "Family history of glaucoma — earlier, more frequent eye exams (AAO)"
    );
  });

  it("diabetes AND current-smoking both tighten dental_cleaning, tightest wins", () => {
    const diabetes = visitModulationFor(
      "dental_cleaning",
      new Set<RiskFactor>(["diabetes"])
    );
    expect(diabetes.multiplier).toBe(0.5);
    expect(diabetes.reasons).toContain(
      "Diabetes on file — periodontal disease risk is higher; more frequent dental visits recommended"
    );

    const smoker = visitModulationFor(
      "dental_cleaning",
      new Set<RiskFactor>(["current-smoking"])
    );
    expect(smoker.reasons).toContain(
      "Current smoking — elevated periodontal risk"
    );

    // Both factors present: multiplier is the min, both reasons ride.
    const both = visitModulationFor(
      "dental_cleaning",
      new Set<RiskFactor>(["diabetes", "current-smoking"])
    );
    expect(both.multiplier).toBe(0.5);
    expect(both.reasons).toHaveLength(2);
  });

  it("noise-exposure and ototoxic-medication each bring hearing_screening sooner (#717)", () => {
    const noise = visitModulationFor(
      "hearing_screening",
      new Set<RiskFactor>(["noise-exposure"])
    );
    expect(noise.multiplier).toBe(0.5);
    expect(noise.priority).toBe(2);
    expect(noise.reasons).toContain(
      "Noise exposure on file — earlier, more frequent hearing checks recommended (NIOSH / CDC)"
    );

    const ototoxic = visitModulationFor(
      "hearing_screening",
      new Set<RiskFactor>(["ototoxic-medication"])
    );
    expect(ototoxic.multiplier).toBe(0.5);
    expect(ototoxic.reasons).toContain(
      "Ototoxic medication on file — hearing monitoring is sometimes advised; a hearing check sooner is reasonable (ASHA)"
    );

    // Both present: tightest multiplier wins, both reasons ride; and neither touches
    // an unrelated visit rule.
    const both = visitModulationFor(
      "hearing_screening",
      new Set<RiskFactor>(["noise-exposure", "ototoxic-medication"])
    );
    expect(both.multiplier).toBe(0.5);
    expect(both.reasons).toHaveLength(2);
    expect(
      visitModulationFor(
        "vision_exam",
        new Set<RiskFactor>(["noise-exposure", "ototoxic-medication"])
      )
    ).toEqual(NO_MODULATION);
  });

  it("does not modulate a retest or screening (visit rules are their own dimension)", () => {
    const f = new Set<RiskFactor>(["diabetes"]);
    // The diabetes visit rules carry no analyte/screening key, so the retest and
    // screening arms are unaffected by them (they still see only their own rules).
    expect(retestModulationFor("vision_exam", f)).toEqual(NO_MODULATION);
    expect(screeningPriorityFor("vision_exam", f)).toEqual({
      priority: 0,
      reasons: [],
      sourced: [],
    });
  });
});

describe("deriveRiskFactors — hereditary-risk genomic inputs (#711)", () => {
  const base = {
    familyConditions: [],
    activeConditions: [],
    attributes: EMPTY_RISK_ATTRIBUTES,
  };

  it("derives hereditary-breast-cancer from a pathogenic BRCA hereditary-risk variant", () => {
    for (const gene of ["BRCA1", "BRCA2"]) {
      for (const significance of ["pathogenic", "likely-pathogenic"] as const) {
        const f = deriveRiskFactors({
          ...base,
          genomicVariants: [
            { gene, significance, result_type: "hereditary-risk" },
          ],
        });
        expect(f.has("hereditary-breast-cancer")).toBe(true);
      }
    }
  });

  it("derives hereditary-colorectal-cancer from any Lynch-syndrome gene", () => {
    for (const gene of ["MLH1", "MSH2", "MSH6", "PMS2", "EPCAM"]) {
      const f = deriveRiskFactors({
        ...base,
        genomicVariants: [
          { gene, significance: "pathogenic", result_type: "hereditary-risk" },
        ],
      });
      expect(f.has("hereditary-colorectal-cancer")).toBe(true);
    }
  });

  it("derives familial-hypercholesterolemia from an FH gene", () => {
    for (const gene of ["LDLR", "APOB", "PCSK9"]) {
      const f = deriveRiskFactors({
        ...base,
        genomicVariants: [
          { gene, significance: "pathogenic", result_type: "hereditary-risk" },
        ],
      });
      expect(f.has("familial-hypercholesterolemia")).toBe(true);
    }
  });

  it("collapses a gene carrying a trailing variant form onto its gene identity (#482)", () => {
    const f = deriveRiskFactors({
      ...base,
      genomicVariants: [
        {
          gene: "BRCA1 c.68_69del",
          significance: "pathogenic",
          result_type: "hereditary-risk",
        },
      ],
    });
    expect(f.has("hereditary-breast-cancer")).toBe(true);
  });

  it("does NOT derive a factor for a predictive-only gene (APOE ε4 — the #711 constraint)", () => {
    // APOE / Huntington etc. are stored factually but carry NO screening action, so
    // they are absent from the curated gene table and produce ZERO factors even when
    // reported as a hereditary-risk result.
    for (const gene of ["APOE", "HTT"]) {
      const f = deriveRiskFactors({
        ...base,
        genomicVariants: [
          { gene, significance: "pathogenic", result_type: "hereditary-risk" },
        ],
      });
      expect(f.size).toBe(0);
    }
  });

  it("does NOT derive a factor from a VUS / benign / null-significance BRCA variant", () => {
    for (const significance of [
      "uncertain-significance",
      "likely-benign",
      "benign",
      null,
    ] as const) {
      const f = deriveRiskFactors({
        ...base,
        genomicVariants: [
          { gene: "BRCA1", significance, result_type: "hereditary-risk" },
        ],
      });
      expect(f.has("hereditary-breast-cancer")).toBe(false);
    }
  });

  it("does NOT derive a factor when a pathogenic BRCA is routed to another consumer", () => {
    for (const result_type of [
      "pharmacogenomic",
      "carrier",
      "diagnostic",
      "other",
    ] as const) {
      const f = deriveRiskFactors({
        ...base,
        genomicVariants: [
          { gene: "BRCA1", significance: "pathogenic", result_type },
        ],
      });
      expect(f.has("hereditary-breast-cancer")).toBe(false);
    }
  });
});

describe("screeningModulationFor (#711)", () => {
  it("is a no-op when no factor targets the screening rule", () => {
    expect(
      screeningModulationFor("mammography", new Set<RiskFactor>())
    ).toEqual(NO_MODULATION);
    // A matching factor but a non-targeted screening still no-ops.
    expect(
      screeningModulationFor(
        "colorectal_cancer",
        new Set<RiskFactor>(["hereditary-breast-cancer"])
      )
    ).toEqual(NO_MODULATION);
  });

  it("BRCA tightens mammography to half cadence with the NCCN reason", () => {
    const mod = screeningModulationFor(
      "mammography",
      new Set<RiskFactor>(["hereditary-breast-cancer"])
    );
    expect(mod.multiplier).toBe(0.5);
    expect(mod.priority).toBe(3);
    expect(mod.reasons[0]).toContain("BRCA pathogenic variant on file");
    // The breast-MRI consideration rides the reason line (no fabricated MRI rule).
    expect(mod.reasons[0]).toContain("breast MRI");
  });

  it("Lynch tightens colorectal_cancer; FH tightens lipid_screening", () => {
    const lynch = screeningModulationFor(
      "colorectal_cancer",
      new Set<RiskFactor>(["hereditary-colorectal-cancer"])
    );
    expect(lynch.multiplier).toBe(0.5);
    expect(lynch.reasons[0]).toContain("Lynch syndrome variant on file");

    const fh = screeningModulationFor(
      "lipid_screening",
      new Set<RiskFactor>(["familial-hypercholesterolemia"])
    );
    expect(fh.multiplier).toBe(0.5);
    expect(fh.reasons[0]).toContain(
      "Familial hypercholesterolemia variant on file"
    );
  });

  it("leaves the priority-only screeningRules ranking a separate dimension", () => {
    // A hereditary cadence factor does not touch a screening's screeningPriorityFor
    // ranking, and a priority-only factor (family-cardiovascular → lipid) does not
    // tighten cadence — the two dimensions are independent.
    expect(
      screeningModulationFor(
        "lipid_screening",
        new Set<RiskFactor>(["family-cardiovascular"])
      )
    ).toEqual(NO_MODULATION);
    expect(
      screeningPriorityFor(
        "mammography",
        new Set<RiskFactor>(["hereditary-breast-cancer"])
      )
    ).toEqual({ priority: 0, reasons: [], sourced: [] });
  });
});

describe("isAnchoredOneShotReading", () => {
  it("treats a newborn bilirubin / metabolic screen drawn in infancy as one-shot", () => {
    expect(isAnchoredOneShotReading("Total Bilirubin", "infant")).toBe(true);
    expect(isAnchoredOneShotReading("Newborn metabolic screen", "infant")).toBe(
      true
    );
  });

  it("does NOT one-shot the same analyte drawn at a later life stage", () => {
    expect(isAnchoredOneShotReading("Total Bilirubin", "adult")).toBe(false);
    expect(isAnchoredOneShotReading("Total Bilirubin", "child")).toBe(false);
    expect(isAnchoredOneShotReading("Total Bilirubin", null)).toBe(false);
  });

  it("does NOT one-shot a non-newborn analyte even in infancy", () => {
    expect(isAnchoredOneShotReading("LDL Cholesterol", "infant")).toBe(false);
  });
});
