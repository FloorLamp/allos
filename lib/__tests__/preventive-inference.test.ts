import { describe, expect, it } from "vitest";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";
import {
  PREVENTIVE_CONCEPT_MAP,
  type InstrumentPage,
} from "@/lib/preventive-concept-map";
import { SUBSTANCE_INSTRUMENTS } from "@/lib/substance-use";
import { INSTRUMENTS } from "@/lib/mental-health";
import {
  inferPreventiveSatisfactions,
  isCompletedStatus,
  matchRuleKeys,
  normalizeCode,
  normalizeMatchText,
  type InferenceRecord,
} from "@/lib/preventive-inference";

const INSTRUMENT_PAGES: InstrumentPage[] = [
  "/records/specialty/substance-use",
  "/records/specialty/mental-health",
];
const ALL_INSTRUMENTS = new Set<string>([
  ...SUBSTANCE_INSTRUMENTS,
  ...INSTRUMENTS,
]);

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
        m.codes.length + m.names.length + m.canonicalResultNames.length
      ).toBeGreaterThan(0);
    }
  });

  it("has one matcher per rule key (no split definitions)", () => {
    const keys = PREVENTIVE_CONCEPT_MAP.map((m) => m.ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every matcher answers the EVENT-ONLY question, and only two say yes (#3025)", () => {
    // `eventNames` is required by TYPE, so a new matcher that never considered it is a
    // compile error rather than a document title silently gaining every needle. This
    // pins WHICH matchers hold one, so moving a conversation word back into `names` —
    // where it would meet a report's title again — has to be a deliberate edit here.
    const withEventNames = PREVENTIVE_CONCEPT_MAP.filter(
      (m) => m.eventNames.length > 0
    ).map((m) => m.ruleKey);
    expect(withEventNames.sort()).toEqual([
      "anxiety_screening",
      "depression_screening",
    ]);
    for (const m of PREVENTIVE_CONCEPT_MAP) {
      // The two lists are disjoint: a needle in both would be document-visible anyway,
      // which is the exact hole the split exists to close.
      for (const n of m.eventNames) {
        expect(m.names, `${m.ruleKey}: ${n}`).not.toContain(n);
      }
    }
  });

  // Every SCREENING declares a `satisfiedBy` concept driving its per-class deep link
  // + CTA (#1083); a VISIT keeps the Book path (no satisfiedBy). The shape must match
  // the rule's evidence: an instrument names a real instrument + page, a vital/lab
  // primary is a canonical biomarker the rule already lists, a procedure names a noun.
  describe("satisfiedBy (#1083)", () => {
    it("every screening matcher declares one; no visit matcher does", () => {
      for (const m of PREVENTIVE_CONCEPT_MAP) {
        if (m.kind === "screening") {
          expect(
            m.satisfiedBy,
            `screening ${m.ruleKey} needs satisfiedBy`
          ).toBeTruthy();
        } else {
          expect(
            m.satisfiedBy,
            `visit ${m.ruleKey} keeps the Book path`
          ).toBeUndefined();
        }
      }
    });

    it("each shape matches the rule's codes/entry", () => {
      for (const m of PREVENTIVE_CONCEPT_MAP) {
        const sb = m.satisfiedBy;
        if (!sb) continue;
        if (sb.kind === "instrument") {
          expect(
            ALL_INSTRUMENTS.has(sb.instrument),
            `${m.ruleKey} instrument`
          ).toBe(true);
          expect(INSTRUMENT_PAGES).toContain(sb.page);
          expect(["in-app", "total-only"]).toContain(sb.entry);
          // The named instrument must be one the rule actually recognizes as a
          // satisfying reading (its canonical biomarker).
          expect(m.canonicalResultNames).toContain(sb.instrument);
        } else if (sb.kind === "lab") {
          // A prefill primary must be a canonical biomarker the rule lists.
          if (sb.primary) {
            expect(
              m.canonicalResultNames,
              `${m.ruleKey} lab primary`
            ).toContain(sb.primary);
          }
        } else if (sb.kind === "vital") {
          expect(
            m.canonicalResultNames,
            `${m.ruleKey} vital primary`
          ).toContain(sb.primary);
        } else {
          expect(
            sb.procedure.length,
            `${m.ruleKey} procedure noun`
          ).toBeGreaterThan(0);
        }
      }
    });

    it("blood pressure is a VITAL, not a lab (a recorded reading IS the screening, #1076)", () => {
      const bp = PREVENTIVE_CONCEPT_MAP.find(
        (m) => m.ruleKey === "blood_pressure"
      );
      expect(bp?.satisfiedBy?.kind).toBe("vital");
    });
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

  it("a coded encounter with a generic title satisfies the visit rule by code (#1035)", () => {
    // Epic's "Office Visit" carrying CPT 99396 — the exact case that failed while
    // the encounter feed hardcoded `code: null`: no name synonym matches, but the
    // code proves it's the annual physical.
    expect(
      matchRuleKeys({ code: "99396", name: "Office Visit" }, ["visit"])
    ).toEqual(["adult_physical"]);
    // CDT-coded dental encounter and CPT-coded eye visit, same shape.
    expect(
      matchRuleKeys({ code: "D0120", name: "Dental encounter" }, ["visit"])
    ).toEqual(["dental_cleaning"]);
    expect(
      matchRuleKeys({ code: "92014", name: "Eye clinic visit" }, ["visit"])
    ).toEqual(["vision_exam"]);
    // A code-less generic encounter still matches nothing (unchanged conservatism)…
    expect(
      matchRuleKeys({ code: null, name: "Office Visit" }, ["visit"])
    ).toEqual([]);
    // …and a code-less encounter with a matching name still matches by name.
    expect(
      matchRuleKeys({ code: null, name: "Annual physical exam" }, ["visit"])
    ).toEqual(["adult_physical"]);
  });

  it("a completed dental procedure satisfies dental_cleaning by CDT code or name (#1037)", () => {
    // The dental record's cdt_code hits the exact-code path with a generic name…
    expect(matchRuleKeys({ code: "D1110", name: "Prophy" }, ["visit"])).toEqual(
      ["dental_cleaning"]
    );
    // …a code-less "teeth cleaning" hits the whole-word synonym path…
    expect(
      matchRuleKeys({ code: null, name: "Teeth cleaning" }, ["visit"])
    ).toEqual(["dental_cleaning"]);
    // …and an unrelated dental row (a filling) matches nothing.
    expect(
      matchRuleKeys({ code: "D2392", name: "Composite filling" }, ["visit"])
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
// EVENT vs DOCUMENT (#3025): which needles a record's `name` may be read with
// ---------------------------------------------------------------------------
describe("matchRuleKeys: the evidence SHAPE", () => {
  it("a DOCUMENT title cannot reach a needle that names a conversation", () => {
    // The reproduction. Admitting `report` (#3025) pointed the concept map at DOCUMENT
    // TITLES for the first time, and the behavioural-health needles were written for the
    // VISIT stream (#997) where "counseling" means a counseling visit. A dietitian's
    // filed note then satisfied BOTH depression and anxiety screening for a year.
    expect(
      matchRuleKeys({ name: "Nutrition Counseling Note", shape: "document" }, [
        "screening",
      ])
    ).toEqual([]);
    // "Genetic Counseling Consultation" is the same word in another specialty.
    expect(
      matchRuleKeys(
        { name: "Genetic Counseling Consultation", shape: "document" },
        ["screening"]
      )
    ).toEqual([]);
  });

  it("the SAME text as an EVENT still satisfies both mental-health screenings (#997)", () => {
    // The other direction, and the reason the split is a shape question rather than a
    // deletion: a completed counseling VISIT is legitimate evidence and must keep
    // working, so a person in active behavioural-health care is not also nagged.
    expect(
      matchRuleKeys({ name: "Counseling session", shape: "event" }, [
        "screening",
      ]).sort()
    ).toEqual(["anxiety_screening", "depression_screening"]);
    // And through the folded appointment-KIND text the mental_health kind contributes.
    expect(
      matchRuleKeys({ name: "Follow-up mental health visit", shape: "event" }, [
        "screening",
      ]).sort()
    ).toEqual(["anxiety_screening", "depression_screening"]);
  });

  it("a DOCUMENT title still satisfies on RESULT-shaped evidence — the #3025 Pap", () => {
    // What the issue was actually about: the document IS the result, and its name is
    // the whole of the evidence.
    expect(
      matchRuleKeys(
        { name: "Cytology, Gyn-PAP Test (AP)", shape: "document" },
        ["screening"]
      )
    ).toEqual(["cervical_cancer"]);
    expect(
      matchRuleKeys(
        { name: "Mammogram, Screening Bilateral", shape: "document" },
        ["screening"]
      )
    ).toEqual(["mammography"]);
    expect(
      matchRuleKeys({ name: "Colonoscopy report", shape: "document" }, [
        "screening",
      ])
    ).toEqual(["colorectal_cancer"]);
  });

  it("a DOCUMENT title that REFUSES its own subject is evidence of nothing", () => {
    // "Screening mammogram declined by patient" is the record of a refusal. Reading it
    // as the mammogram is a missed cancer screening.
    for (const name of [
      "Screening mammogram declined by patient",
      "Pap test refused",
      "Colonoscopy not performed",
      "Mammogram cancelled — no show",
    ]) {
      expect(
        matchRuleKeys({ name, shape: "document" }, ["screening"]),
        name
      ).toEqual([]);
    }
    // Whole-word, so a longer token carrying the letters is not a refusal.
    expect(
      matchRuleKeys(
        { name: "Mammogram, screening — undeclined", shape: "document" },
        ["screening"]
      )
    ).toEqual(["mammography"]);
    // The guard covers every path, not just the name one: a refusal that also carries
    // the canonical name of a result proves nothing either.
    expect(
      matchRuleKeys(
        {
          name: "Lipid panel declined",
          canonicalName: "LDL Cholesterol",
          shape: "document",
        },
        ["screening"]
      )
    ).toEqual([]);
  });

  it("defaults to `event`, which is what every source was before #3025", () => {
    // The permissive default lives here, on the low-level matcher; `InferenceRecord`
    // REQUIRES the field, so a new SOURCE cannot forget to answer.
    expect(
      matchRuleKeys({ name: "Counseling session" }, ["screening"]).sort()
    ).toEqual(["anxiety_screening", "depression_screening"]);
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
        shape: "event",
      },
      {
        code: null,
        name: "Lipid panel",
        canonicalName: "LDL Cholesterol",
        date: "2025-01-15T09:30:00",
        allow: ["screening"],
        shape: "document",
      },
      {
        code: null,
        name: "Annual physical",
        date: "2026-02-02",
        allow: ["visit"],
        shape: "event",
      },
      // Undated → skipped (can't place on the timeline).
      {
        code: "77067",
        name: "Mammogram",
        date: null,
        allow: ["screening"],
        shape: "event",
      },
      // Unmatched → contributes nothing.
      {
        code: null,
        name: "Grocery list",
        date: "2026-01-01",
        allow: ["visit"],
        shape: "event",
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
        shape: "event",
      },
    ]);
    expect(sats).toEqual([
      { ruleKey: "colorectal_cancer", date: "2023-06-06" },
    ]);
  });
});
