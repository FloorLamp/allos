import { describe, it, expect } from "vitest";
import {
  screeningResultRuleKey,
  inferScreeningResultSatisfactions,
  type ScreeningResultInput,
} from "@/lib/preventive-screening-result";

function result(
  over: Partial<ScreeningResultInput> = {}
): ScreeningResultInput {
  return {
    name: "HIV 1/2 Antibody",
    value: "Non-Reactive",
    notes: null,
    reference: null,
    loinc: null,
    date: "2026-05-01",
    ...over,
  };
}

describe("screeningResultRuleKey (#686)", () => {
  it("maps an HPV result (by LOINC) to cervical-cancer screening — the #86 name-inference gap", () => {
    // "HPV, High Risk" matches no Pap/HPV *test* name synonym and carries no CPT, so
    // the #86 inference misses it; the LOINC resolves the concept.
    expect(
      screeningResultRuleKey(
        result({ name: "HPV, High Risk", value: "Detected", loinc: "30167-1" })
      )
    ).toBe("cervical_cancer");
    // Each genotype LOINC resolves the same rule.
    expect(
      screeningResultRuleKey(
        result({ name: "HPV Genotype 16", value: "Detected", loinc: "59263-4" })
      )
    ).toBe("cervical_cancer");
    // HPV WITHOUT a LOINC is deliberately null: the classifier's INFECTION_MARKER
    // doesn't include HPV, so a name-only HPV row doesn't classify. Real Epic exports
    // carry the LOINC (#684), which is the recognized path.
    expect(
      screeningResultRuleKey(
        result({ name: "Human Papillomavirus", value: "Not Detected" })
      )
    ).toBeNull();
  });

  it("maps HIV / hepatitis-C / hepatitis-B results to their screening rules", () => {
    expect(screeningResultRuleKey(result({ value: "Non-Reactive" }))).toBe(
      "hiv_screening"
    );
    expect(
      screeningResultRuleKey(
        result({ name: "Hepatitis C Antibody", value: "Non-Reactive" })
      )
    ).toBe("hepatitis_c");
    expect(
      screeningResultRuleKey(
        result({ name: "Hepatitis B Surface Antigen", value: "Negative" })
      )
    ).toBe("hepatitis_b");
  });

  it("counts a NEGATIVE and a POSITIVE result alike (being tested advances the cadence)", () => {
    expect(screeningResultRuleKey(result({ value: "Non-Reactive" }))).toBe(
      "hiv_screening"
    );
    expect(screeningResultRuleKey(result({ value: "Reactive" }))).toBe(
      "hiv_screening"
    );
  });

  it("does NOT let a hepatitis-B SURFACE ANTIBODY (immunity) satisfy the infection screen", () => {
    // Positive anti-HBs is immunity, not an HBsAg infection screen → no hepatitis_b.
    expect(
      screeningResultRuleKey(
        result({ name: "Hepatitis B Surface Antibody", value: "Positive" })
      )
    ).toBeNull();
  });

  it("returns null for a concept with no catalog screening rule (exclusion discipline)", () => {
    // Chlamydia/gonorrhea/syphilis/GBS have no preventive rule — satisfy nothing.
    expect(
      screeningResultRuleKey(
        result({ name: "Chlamydia trachomatis NAAT", value: "Detected" })
      )
    ).toBeNull();
    expect(
      screeningResultRuleKey(
        result({ name: "Group B Streptococcus", value: "Positive" })
      )
    ).toBeNull();
  });

  it("returns null for an uninterpretable / non-qualitative row (the classifier is the gate)", () => {
    // A blank/uninterpretable value doesn't classify → not a screening event.
    expect(
      screeningResultRuleKey(
        result({ name: "HIV 1/2 Antibody", value: "See report" })
      )
    ).toBeNull();
    // A lipid number is not a qualitative result the classifier recognizes.
    expect(
      screeningResultRuleKey(result({ name: "LDL Cholesterol", value: "130" }))
    ).toBeNull();
  });
});

describe("inferScreeningResultSatisfactions (#686)", () => {
  it("emits one (ruleKey, date) satisfaction per recognized result, dropping undated rows", () => {
    const out = inferScreeningResultSatisfactions([
      result({
        name: "HPV, High Risk",
        value: "Detected",
        loinc: "30167-1",
        date: "2026-01-10",
      }),
      result({
        name: "HIV 1/2 Antibody",
        value: "Non-Reactive",
        date: "2026-02-20",
      }),
      // Undated → dropped (can't be placed on the cadence timeline).
      result({
        name: "Hepatitis C Antibody",
        value: "Non-Reactive",
        date: null,
      }),
      // Unmapped concept → nothing.
      result({ name: "Chlamydia NAAT", value: "Detected", date: "2026-03-01" }),
    ]);
    expect(out).toEqual([
      { ruleKey: "cervical_cancer", date: "2026-01-10" },
      { ruleKey: "hiv_screening", date: "2026-02-20" },
    ]);
  });
});
