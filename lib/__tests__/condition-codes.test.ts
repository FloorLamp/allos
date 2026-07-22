import { describe, expect, it } from "vitest";
import {
  conditionCodeConcepts,
  conditionCodeMatches,
} from "../condition-codes";
import {
  conditionsToRiskFactors,
  deriveRiskFactors,
} from "../risk-stratification";
import { EMPTY_RISK_ATTRIBUTES } from "../risk-stratification";
import { crossCheckContrast } from "../contrast-safety";
import { crossCheckDentalSafety, DENTAL_GATE_CONCEPTS } from "../dental-safety";
import { DENTAL_CONDITION_GATES } from "../datasets/dental-safety";
import {
  conditionMatchesTerm,
  conditionsContraindicatingNutrient,
} from "../condition-nutrient";
import { conditionConflict } from "../supplement-safety";

// Issue #1030 — the coded half of the condition recognizers. All synthetic
// fixtures: standard public vocabulary codes with obviously-generic labels.

describe("conditionCodeConcepts — the curated code table", () => {
  it("maps ICD-10 family codes dot- and case-insensitively", () => {
    expect(
      conditionCodeConcepts({
        name: "DM2",
        code: "E11.9",
        codeSystem: "ICD-10-CM",
      })
    ).toContain("diabetes");
    expect(
      conditionCodeConcepts({ name: "DM2", code: "e119", codeSystem: "ICD-10" })
    ).toContain("diabetes");
  });

  it("maps SNOMED ids exactly (never as a prefix)", () => {
    expect(
      conditionCodeConcepts({
        name: "T2DM",
        code: "44054006",
        codeSystem: "SNOMED CT",
      })
    ).toContain("diabetes");
    // A longer id that merely STARTS with a curated one is a different concept.
    expect(
      conditionCodeConcepts({
        name: "x",
        code: "440540061",
        codeSystem: "SNOMED CT",
      }).size
    ).toBe(0);
  });

  it("an unknown code (no curated entry) yields NOTHING — never a guess", () => {
    expect(
      conditionCodeConcepts({
        name: "Migraine",
        code: "G43.909",
        codeSystem: "ICD-10-CM",
      }).size
    ).toBe(0);
  });

  it("a non-ICD-10/SNOMED system never code-matches (exclusion discipline)", () => {
    // ICD-9 250.00 is diabetes, but ICD-9 is not a curated vocabulary here —
    // and its all-digit shape must NOT be misread as SNOMED.
    expect(
      conditionCodeConcepts({
        name: "Diabetes",
        code: "250.00",
        codeSystem: "ICD-9-CM",
      }).size
    ).toBe(0);
  });

  it("a NULL/unknown system falls back to the code's shape (letter-led → ICD-10, all-digit → SNOMED)", () => {
    expect(
      conditionCodeConcepts({ name: "DM2", code: "E11.9", codeSystem: null })
    ).toContain("diabetes");
    expect(conditionCodeConcepts({ name: "HTN", code: "38341003" })).toContain(
      "hypertension"
    );
  });

  it("a combination code activates every concept it codes (I12 → hypertension + CKD)", () => {
    const c = conditionCodeConcepts({
      name: "Hypertensive CKD",
      code: "I12.9",
      codeSystem: "ICD-10-CM",
    });
    expect(c).toContain("hypertension");
    expect(c).toContain("chronic-kidney-disease");
  });

  it("stage 4-5/ESRD codes add the advanced-kidney-disease concept", () => {
    const stage5 = conditionCodeConcepts({
      name: "CKD",
      code: "N18.5",
      codeSystem: "ICD-10-CM",
    });
    expect(stage5).toContain("chronic-kidney-disease");
    expect(stage5).toContain("advanced-kidney-disease");
    // Stage 3 is CKD but NOT advanced.
    expect(
      conditionCodeMatches(
        { name: "CKD", code: "N18.30", codeSystem: "ICD-10-CM" },
        "advanced-kidney-disease"
      )
    ).toBe(false);
  });

  it("bare strings and uncoded refs yield nothing (the name path handles them)", () => {
    expect(conditionCodeConcepts("type 2 diabetes").size).toBe(0);
    expect(conditionCodeConcepts({ name: "type 2 diabetes" }).size).toBe(0);
  });
});

describe("conditionsToRiskFactors — code-first, stem fallback (#1030 matrix)", () => {
  it("coded-only hit: 'DM2' + E11.9 lands the diabetes factor", () => {
    expect(
      conditionsToRiskFactors([
        { name: "DM2", code: "E11.9", codeSystem: "ICD-10-CM" },
      ])
    ).toContain("diabetes");
  });

  it("stem-only hit: an uncoded 'type 2 diabetes' still matches (unchanged)", () => {
    expect(conditionsToRiskFactors(["type 2 diabetes"])).toContain("diabetes");
    expect(conditionsToRiskFactors([{ name: "type 2 diabetes" }])).toContain(
      "diabetes"
    );
  });

  it("both agree: coded + verbose name yields the one factor", () => {
    const f = conditionsToRiskFactors([
      {
        name: "Type 2 diabetes mellitus",
        code: "E11.9",
        codeSystem: "ICD-10-CM",
      },
    ]);
    expect(f).toEqual(new Set(["diabetes"]));
  });

  it("code-vs-stem disagreement: the code's factor is matched (authoritative), per-concept union keeps the stem's too", () => {
    // The code is what the record PROVES; the matchConceptKeysIn union shape
    // ("both are collected so a mislabeled row still matches on whichever signal
    // fits") keeps the name's concept as well rather than suppressing it — a
    // per-row code-wins rule would REGRESS combination rows (next test).
    const f = conditionsToRiskFactors([
      { name: "hypertension", code: "E11.9", codeSystem: "ICD-10-CM" },
    ]);
    expect(f).toContain("diabetes");
    expect(f).toContain("hypertension");
  });

  it("a combination row keeps its name's kidney stem alongside the code (E11.21)", () => {
    const f = conditionsToRiskFactors([
      {
        name: "Type 2 diabetes with diabetic nephropathy",
        code: "E11.21",
        codeSystem: "ICD-10-CM",
      },
    ]);
    expect(f).toContain("diabetes");
    expect(f).toContain("chronic-kidney-disease");
  });

  it("unknown code + unknown name yields nothing (exclusion discipline pinned)", () => {
    expect(
      conditionsToRiskFactors([
        { name: "Zorblax syndrome", code: "Q99.999", codeSystem: "ICD-10-CM" },
      ]).size
    ).toBe(0);
  });
});

describe("deriveRiskFactors — coded family history (#1030)", () => {
  const base = {
    familyConditions: [],
    activeConditions: [],
    attributes: EMPTY_RISK_ATTRIBUTES,
  };

  it("a coded-terse family cardiac row (I25.10) activates family-cardiovascular", () => {
    const f = deriveRiskFactors({
      ...base,
      familyConditions: [
        { name: "CAD", code: "I25.10", codeSystem: "ICD-10-CM" },
      ],
    });
    expect(f).toContain("family-cardiovascular");
  });

  it("a coded-terse family stroke ('CVA' + I63) activates family-cardiovascular (#1039 residual)", () => {
    // The #1030 code-first family fix covered the ischemic-heart half ("MI"/CAD in
    // I20–I25) but not the cerebrovascular half: "CVA" has no "stroke" substring and
    // I63 was outside the code family, so a coded stroke dropped. The added stroke
    // codes close it — matching the FAMILY_KEYWORDS "stroke" stem's intent.
    const f = deriveRiskFactors({
      ...base,
      familyConditions: [
        { name: "CVA", code: "I63.9", codeSystem: "ICD-10-CM" },
      ],
    });
    expect(f).toContain("family-cardiovascular");
  });

  it("a stroke coded by SNOMED (230690007) also activates family-cardiovascular", () => {
    const f = deriveRiskFactors({
      ...base,
      familyConditions: [
        {
          name: "Cerebrovascular accident",
          code: "230690007",
          codeSystem: "SNOMED CT",
        },
      ],
    });
    expect(f).toContain("family-cardiovascular");
  });

  it("a non-event cerebrovascular code (I67 sequelae/other) does NOT activate the factor (exclusion discipline)", () => {
    const f = deriveRiskFactors({
      ...base,
      familyConditions: [
        {
          name: "Chronic cerebral ischemia",
          code: "I67.81",
          codeSystem: "ICD-10-CM",
        },
      ],
    });
    expect(f).not.toContain("family-cardiovascular");
  });

  it("a coded family malignancy (C50.911) activates family-cancer", () => {
    const f = deriveRiskFactors({
      ...base,
      familyConditions: [
        { name: "Breast CA", code: "C50.911", codeSystem: "ICD-10-CM" },
      ],
    });
    expect(f).toContain("family-cancer");
  });

  it("a coded-terse ACTIVE condition ('DM2' + E11.9) still lands via the shared recognizer", () => {
    const f = deriveRiskFactors({
      ...base,
      activeConditions: [
        { name: "DM2", code: "E11.9", codeSystem: "ICD-10-CM" },
      ],
    });
    expect(f).toContain("diabetes");
  });
});

describe("contrast CKD gate — coded conditions (#1030)", () => {
  const study = {
    source: "careplan" as const,
    sourceId: 7,
    contrastClass: "iodinated" as const,
    label: "CT abdomen with contrast",
    date: "2027-01-10",
  };

  it("a coded-terse CKD row fires the renal gate", () => {
    const hits = crossCheckContrast([study], {
      allergens: [],
      conditions: [{ name: "CKD", code: "N18.30", codeSystem: "ICD-10-CM" }],
    });
    expect(hits.some((h) => h.gate === "renal")).toBe(true);
    expect(hits.find((h) => h.gate === "renal")?.matchedOn).toBe("CKD");
  });

  it("a coded stage-5 row (terse label) reaches the gadolinium/NSF advanced gate", () => {
    const gad = { ...study, contrastClass: "gadolinium" as const };
    const hits = crossCheckContrast([gad], {
      allergens: [],
      conditions: [
        { name: "Kidney disease", code: "N18.5", codeSystem: "ICD-10-CM" },
      ],
    });
    expect(hits.some((h) => h.gate === "renal")).toBe(true);
  });

  it("an unrelated coded condition fires nothing", () => {
    const hits = crossCheckContrast([study], {
      allergens: [],
      conditions: [
        { name: "Migraine", code: "G43.909", codeSystem: "ICD-10-CM" },
      ],
    });
    expect(hits).toEqual([]);
  });
});

describe("dental cardiac gate — coded conditions (#1030)", () => {
  const extraction = {
    id: 3,
    label: "Extraction · #17",
    date: "2027-02-01",
  };

  it("every DENTAL_GATE_CONCEPTS key names a real dataset gate (mapping can't orphan)", () => {
    const keys = new Set(DENTAL_CONDITION_GATES.map((g) => g.key));
    for (const k of Object.keys(DENTAL_GATE_CONCEPTS)) {
      expect(keys.has(k), `unknown dental gate key ${k}`).toBe(true);
    }
  });

  it("a coded-terse prosthetic valve ('AVR' + Z95.2) triggers the prophylaxis note", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [],
      [{ name: "AVR", code: "Z95.2", codeSystem: "ICD-10-CM" }]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("cardiac");
    expect(hits[0].gateKey).toBe("prosthetic_valve");
    expect(hits[0].matchedOn).toBe("AVR");
  });

  it("a coded endocarditis history (I33.0) and transplant status (Z94.1) hit their gates", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [],
      [
        { name: "IE 2019", code: "I33.0", codeSystem: "ICD-10-CM" },
        { name: "s/p transplant", code: "Z94.1", codeSystem: "ICD-10-CM" },
      ]
    );
    expect(new Set(hits.map((h) => h.gateKey))).toEqual(
      new Set(["prior_endocarditis", "cardiac_transplant_valvulopathy"])
    );
  });

  it("keyword matching for uncoded rows is unchanged, and unknown codes fall through to it", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [],
      [
        {
          name: "Prosthetic heart valve",
          code: "X99.9",
          codeSystem: "ICD-10-CM",
        },
      ]
    );
    expect(hits.some((h) => h.gateKey === "prosthetic_valve")).toBe(true);
  });
});

describe("condition→nutrient rules — coded conditions (#1030)", () => {
  it("conditionMatchesTerm is code-first with the name-substring fallback", () => {
    // Coded-terse CKD: no "chronic kidney" substring, the code carries it.
    expect(
      conditionMatchesTerm("chronic kidney", {
        name: "CKD stage 3",
        code: "N18.30",
        codeSystem: "ICD-10-CM",
      })
    ).toBe(true);
    // Name fallback unchanged for uncoded rows.
    expect(
      conditionMatchesTerm("chronic kidney", "Chronic kidney disease, stage 3")
    ).toBe(true);
    expect(conditionMatchesTerm("chronic kidney", "hypertension")).toBe(false);
  });

  it("the UL-caveat read fires for a coded-terse row", () => {
    const hits = conditionsContraindicatingNutrient("magnesium", [
      { name: "CKD stage 3", code: "N18.30", codeSystem: "ICD-10-CM" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].condition).toBe("CKD stage 3");
  });

  it("the supplement belt drops a potassium suggestion for a coded hyperkalemia row", () => {
    const hit = conditionConflict("Potassium citrate", [
      { name: "High K", code: "E87.5", codeSystem: "ICD-10-CM" },
    ]);
    expect(hit).not.toBeNull();
    expect(hit!.condition).toBe("High K");
  });
});

describe("conditionCodeConcepts — site-specific family-cancer concepts (#1039)", () => {
  it("maps colon/rectal ICD-10 to colorectal-cancer AND the malignant catch-all", () => {
    for (const code of ["C18.9", "C19", "C20"]) {
      const c = conditionCodeConcepts({
        name: "GI tumor",
        code,
        codeSystem: "ICD-10-CM",
      });
      expect(c.has("colorectal-cancer"), code).toBe(true);
      expect(c.has("malignant-neoplasm"), code).toBe(true);
    }
  });

  it("maps breast ICD-10 (C50) to breast-cancer, not colorectal", () => {
    const c = conditionCodeConcepts({
      name: "Breast tumor",
      code: "C50.911",
      codeSystem: "ICD-10-CM",
    });
    expect(c.has("breast-cancer")).toBe(true);
    expect(c.has("colorectal-cancer")).toBe(false);
    expect(c.has("malignant-neoplasm")).toBe(true);
  });

  it("excludes anus (C21) and small intestine (C17) from colorectal", () => {
    for (const code of ["C21.0", "C17.9"]) {
      const c = conditionCodeConcepts({
        name: "GI tumor",
        code,
        codeSystem: "ICD-10-CM",
      });
      expect(c.has("colorectal-cancer"), code).toBe(false);
      // Still a malignant neoplasm (the "C" catch-all).
      expect(c.has("malignant-neoplasm"), code).toBe(true);
    }
  });

  it("matches SNOMED malignant tumor of colon / breast", () => {
    expect(
      conditionCodeMatches(
        { name: "Colon Ca", code: "363406005", codeSystem: "SNOMED CT" },
        "colorectal-cancer"
      )
    ).toBe(true);
    expect(
      conditionCodeMatches(
        { name: "Breast Ca", code: "254837009", codeSystem: "SNOMED CT" },
        "breast-cancer"
      )
    ).toBe(true);
  });
});
