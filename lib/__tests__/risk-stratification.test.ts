import { describe, expect, it } from "vitest";
import {
  deriveRiskFactors,
  retestModulationFor,
  screeningPriorityFor,
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
    ).toEqual({ priority: 0, reasons: [] });
    expect(
      screeningPriorityFor("lipid_screening", new Set<RiskFactor>())
    ).toEqual({ priority: 0, reasons: [] });
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
