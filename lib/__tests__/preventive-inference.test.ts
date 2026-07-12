import { describe, expect, it } from "vitest";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";
import { PREVENTIVE_CONCEPT_MAP } from "@/lib/preventive-concept-map";
import {
  inferPreventiveSatisfactions,
  isCompletedStatus,
  matchRuleKeys,
  normalizeCode,
  normalizeMatchText,
  type InferenceRecord,
} from "@/lib/preventive-inference";

// ---------------------------------------------------------------------------
// Concept-map integrity
// ---------------------------------------------------------------------------
describe("preventive concept map", () => {
  it("references only real catalog rules, with a matching kind", () => {
    for (const m of PREVENTIVE_CONCEPT_MAP) {
      const rule = preventiveRuleByKey(m.ruleKey);
      expect(rule, `unknown rule ${m.ruleKey}`).toBeTruthy();
      expect(rule!.kind).toBe(m.kind);
      // Every matcher must carry at least one usable signal.
      expect(
        m.codes.length + m.names.length + m.canonicalBiomarkers.length
      ).toBeGreaterThan(0);
    }
  });

  it("has one matcher per rule key (no split definitions)", () => {
    const keys = PREVENTIVE_CONCEPT_MAP.map((m) => m.ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Text / code normalization
// ---------------------------------------------------------------------------
describe("normalization", () => {
  it("space-wraps and lowercases match text for whole-word tests", () => {
    expect(normalizeMatchText("Screening Colonoscopy!")).toBe(
      " screening colonoscopy "
    );
    expect(normalizeMatchText(null)).toBe(" ");
    expect(normalizeMatchText("   ")).toBe(" ");
  });

  it("uppercases and trims codes", () => {
    expect(normalizeCode(" g0121 ")).toBe("G0121");
    expect(normalizeCode(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Matching — the conservative core
// ---------------------------------------------------------------------------
describe("matchRuleKeys", () => {
  it("matches a colonoscopy by exact CPT code", () => {
    expect(matchRuleKeys({ code: "45378" }, ["screening"])).toEqual([
      "colorectal_cancer",
    ]);
  });

  it("matches a colonoscopy by whole-word name", () => {
    expect(
      matchRuleKeys({ name: "Screening colonoscopy" }, ["screening"])
    ).toEqual(["colorectal_cancer"]);
  });

  it("does NOT match a stool-based colorectal test (conservative interval)", () => {
    // FIT/FOBT need annual rescreening; they are intentionally unmapped so they
    // never grant the catalog's 10-year colonoscopy pass.
    expect(
      matchRuleKeys({ code: "82274", name: "Fecal immunochemical test" }, [
        "screening",
      ])
    ).toEqual([]);
  });

  it("matches whole words only — not substrings of larger tokens", () => {
    // "hpv" appears in the name but the synonyms are the phrases "hpv test" /
    // "hpv screening", so a bare "hpv genotyping" does not match.
    expect(matchRuleKeys({ name: "HPV genotyping" }, ["screening"])).toEqual(
      []
    );
    // "hemoglobin" alone is not the A1c analyte.
    expect(matchRuleKeys({ name: "Hemoglobin" }, ["screening"])).toEqual([]);
    expect(
      matchRuleKeys({ name: "Hemoglobin A1c panel" }, ["screening"])
    ).toEqual(["diabetes_screening"]);
  });

  it("matches lab screenings by exact canonical biomarker name", () => {
    expect(
      matchRuleKeys({ canonicalName: "LDL Cholesterol" }, ["screening"])
    ).toEqual(["lipid_screening"]);
    expect(
      matchRuleKeys({ canonicalName: "Blood Pressure Systolic" }, ["screening"])
    ).toEqual(["blood_pressure"]);
  });

  it("gates matches by allowed rule kind (source semantics)", () => {
    // A visit synonym on a screening-only source (a procedure) never counts.
    expect(matchRuleKeys({ name: "Annual physical" }, ["screening"])).toEqual(
      []
    );
    // Same text from a visit source matches.
    expect(matchRuleKeys({ name: "Annual physical exam" }, ["visit"])).toEqual([
      "adult_physical",
    ]);
    // A lab canonical name never satisfies a visit rule.
    expect(
      matchRuleKeys({ canonicalName: "LDL Cholesterol" }, ["visit"])
    ).toEqual([]);
  });

  it("matches specialty 'see the right kind of doctor' visits by specialty word (issue #515)", () => {
    // A dermatology visit's evidence — the provider/facility name folds into the
    // matched text for encounters — satisfies skin_check via the specialty word.
    expect(
      matchRuleKeys({ name: "Office Visit Cedar Dermatology Clinic" }, [
        "visit",
      ])
    ).toEqual(["skin_check"]);
    // The explicit phrase in notes still matches too.
    expect(
      matchRuleKeys({ name: "Follow-up full body skin exam performed" }, [
        "visit",
      ])
    ).toEqual(["skin_check"]);
    // Analogous specialty words for the other structured-specialty rules.
    expect(
      matchRuleKeys({ name: "Visit with an ophthalmologist" }, ["visit"])
    ).toEqual(["vision_exam"]);
    expect(matchRuleKeys({ name: "Saw the dentist" }, ["visit"])).toEqual([
      "dental_cleaning",
    ]);
    // Bare "skin" is NOT one of the specific phrases — conservative (#86) still holds.
    expect(matchRuleKeys({ name: "Dry skin on the arm" }, ["visit"])).toEqual(
      []
    );
  });

  it("matches a depression screen by PHQ code and whole-word name", () => {
    expect(matchRuleKeys({ code: "G0444" }, ["screening"])).toEqual([
      "depression_screening",
    ]);
    expect(
      matchRuleKeys({ name: "PHQ-9 depression screening" }, ["screening"])
    ).toEqual(["depression_screening"]);
  });

  it("matches mammography and DEXA the issue calls out", () => {
    expect(matchRuleKeys({ code: "77067" }, ["screening"])).toEqual([
      "mammography",
    ]);
    expect(matchRuleKeys({ name: "DEXA scan" }, ["screening"])).toEqual([
      "osteoporosis",
    ]);
  });

  it("returns [] for empty / unmatched records", () => {
    expect(matchRuleKeys({}, ["screening", "visit"])).toEqual([]);
    expect(
      matchRuleKeys({ code: "99999", name: "Unrelated note" }, [
        "screening",
        "visit",
      ])
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Completion status
// ---------------------------------------------------------------------------
describe("isCompletedStatus", () => {
  it("recognizes completed-ish states, case-insensitively", () => {
    for (const s of ["completed", "COMPLETE", " done ", "fulfilled"]) {
      expect(isCompletedStatus(s)).toBe(true);
    }
  });
  it("treats planned/blank/unknown as NOT completed", () => {
    for (const s of ["planned", "active", "in-progress", "", null, undefined]) {
      expect(isCompletedStatus(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end inference over a record set
// ---------------------------------------------------------------------------
describe("inferPreventiveSatisfactions", () => {
  it("derives (ruleKey, date) satisfactions, normalizing datetimes and dropping undated rows", () => {
    const records: InferenceRecord[] = [
      {
        code: "45378",
        name: "Colonoscopy",
        date: "2022-03-01",
        allow: ["screening"],
      },
      {
        code: null,
        name: "Lipid panel",
        canonicalName: "LDL Cholesterol",
        date: "2025-01-15T09:30:00",
        allow: ["screening"],
      },
      {
        code: null,
        name: "Annual physical",
        date: "2026-02-02",
        allow: ["visit"],
      },
      // Undated → skipped (can't place on the timeline).
      { code: "77067", name: "Mammogram", date: null, allow: ["screening"] },
      // Unmatched → contributes nothing.
      {
        code: null,
        name: "Grocery list",
        date: "2026-01-01",
        allow: ["visit"],
      },
    ];

    const sats = inferPreventiveSatisfactions(records);
    expect(sats).toContainEqual({
      ruleKey: "colorectal_cancer",
      date: "2022-03-01",
    });
    expect(sats).toContainEqual({
      ruleKey: "lipid_screening",
      date: "2025-01-15",
    });
    expect(sats).toContainEqual({
      ruleKey: "adult_physical",
      date: "2026-02-02",
    });
    expect(sats.some((s) => s.ruleKey === "mammography")).toBe(false);
    expect(sats).toHaveLength(3);
  });

  it("emits one satisfaction per matched rule when a record hits several", () => {
    // A completed care-plan item both named and coded still yields exactly its
    // single mapped rule (de-duplicated).
    const sats = inferPreventiveSatisfactions([
      {
        code: "45378",
        name: "Screening colonoscopy",
        date: "2023-06-06",
        allow: ["screening", "visit"],
      },
    ]);
    expect(sats).toEqual([
      { ruleKey: "colorectal_cancer", date: "2023-06-06" },
    ]);
  });
});
