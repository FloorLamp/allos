import { describe, expect, it } from "vitest";
import { MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";
import { inferPreventiveSatisfactions } from "@/lib/preventive-inference";
import {
  PREVENTIVE_EVIDENCE_CENSUS,
  derivePreventiveReviewCandidates,
  offeredPreventiveReviewCandidates,
  preventiveEvidenceClass,
  preventiveEvidenceRecord,
  preventiveReviewFactKey,
  preventiveReviewQuestion,
  type PreventiveEvidenceObservation,
  type PreventiveReviewCandidate,
  type PreventiveReviewSource,
} from "@/lib/preventive-review";
import { preventiveReviewCandidate } from "@/lib/dashboard-candidates/attention";
import { rankDashboardCandidates } from "@/lib/dashboard-relevance";

// The #3025 boundary, unit-tested with no DB: structured evidence decides,
// prose asks. Auto-satisfaction from a document row exists only through an
// identity the concept map authored (exact code, curated canonical name);
// free text in a title may only OFFER a review candidate — and only when it
// matches exactly one screening rule.

function obs(
  over: Partial<PreventiveEvidenceObservation> &
    Pick<PreventiveEvidenceObservation, "category" | "name">
): PreventiveEvidenceObservation {
  return { canonical_name: null, loinc: null, date: "2024-09-20", ...over };
}

function satisfiedRules(o: PreventiveEvidenceObservation): string[] {
  const rec = preventiveEvidenceRecord(o);
  return rec ? inferPreventiveSatisfactions([rec]).map((s) => s.ruleKey) : [];
}

function report(
  over: Partial<PreventiveReviewSource> & Pick<PreventiveReviewSource, "name">
): PreventiveReviewSource {
  return {
    id: 1,
    category: "report",
    date: "2024-09-20",
    value: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The closed category census
// ---------------------------------------------------------------------------
describe("preventive evidence census", () => {
  it("classifies every importer-written category — the census is closed", () => {
    for (const category of MEDICAL_CATEGORIES) {
      expect(
        PREVENTIVE_EVIDENCE_CENSUS[category],
        `unclassified category ${category}`
      ).toBeTruthy();
    }
    // And nothing beyond the enum: the census cannot invent categories.
    expect(Object.keys(PREVENTIVE_EVIDENCE_CENSUS).sort()).toEqual(
      [...MEDICAL_CATEGORIES].sort()
    );
  });

  it("every non-result classification states its reason", () => {
    for (const category of MEDICAL_CATEGORIES) {
      const cls = PREVENTIVE_EVIDENCE_CENSUS[category];
      if (cls.evidence !== "result") {
        expect(cls.reason.length, `${category} needs a reason`).toBeGreaterThan(
          0
        );
      }
    }
  });

  it("an unclassified category fails the guard loudly, never silently", () => {
    expect(() => preventiveEvidenceClass("pathology")).toThrowError(
      /[Uu]nclassified/
    );
  });

  it("the #2877 NULL review state and excluded categories are not evidence", () => {
    expect(
      preventiveEvidenceRecord(obs({ category: null, name: "Colonoscopy" }))
    ).toBeNull();
    expect(
      preventiveEvidenceRecord(
        obs({ category: "prescription", name: "Colonoscopy" })
      )
    ).toBeNull();
    // Category membership alone never proves completion: an eligible
    // document-class row with NO structured identity satisfies nothing.
    expect(
      satisfiedRules(obs({ category: "report", name: "Colonoscopy" }))
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structured evidence decides
// ---------------------------------------------------------------------------
describe("structured evidence (auto-satisfaction)", () => {
  it("result categories keep the unchanged #86 shape — title matching included", () => {
    const rec = preventiveEvidenceRecord(
      obs({
        category: "lab",
        name: "Lipid panel",
        canonical_name: "LDL Cholesterol",
      })
    );
    expect(rec).toEqual({
      code: null,
      name: "Lipid panel",
      canonicalName: "LDL Cholesterol",
      date: "2024-09-20",
      allow: ["screening"],
    });
    // A refusal-free title on a result row matches exactly as today.
    expect(
      satisfiedRules(obs({ category: "lab", name: "Hemoglobin A1c" }))
    ).toEqual(["diabetes_screening"]);
  });

  it("an exact concept-map code on a document row auto-satisfies", () => {
    // The row's coded identity rides the exact-code path (the map authored
    // 88141, CPT cervical cytopathology).
    expect(
      satisfiedRules(
        obs({ category: "report", name: "Some narrative", loinc: "88141" })
      )
    ).toEqual(["cervical_cancer"]);
  });

  it("a curated canonical name on a document row auto-satisfies", () => {
    expect(
      satisfiedRules(
        obs({
          category: "report",
          name: "Chemistry narrative",
          canonical_name: "LDL Cholesterol",
        })
      )
    ).toEqual(["lipid_screening"]);
  });

  it("identity beats prose: no wording can withhold an authored identity", () => {
    // The attempt-3 lesson — a code or curated canonical name is evidence the
    // concept map authored; refusal wording in the free-text title must not
    // erase it.
    expect(
      satisfiedRules(
        obs({
          category: "report",
          name: "Lipid panel — fasting not done",
          canonical_name: "LDL Cholesterol",
        })
      )
    ).toEqual(["lipid_screening"]);
    expect(
      satisfiedRules(
        obs({
          category: "report",
          name: "Pap smear — patient declined HPV co-test",
          loinc: "88141",
        })
      )
    ).toEqual(["cervical_cancer"]);
  });

  it("changing only a free-text title never auto-satisfies a document row", () => {
    // The recorded failure cases from attempts 1–3, plus the genuine Pap: with
    // no structured identity, NO title wording — matching, ordering, refusing —
    // may change due status on its own.
    for (const name of [
      "Cytology, Gyn-PAP Test (AP)", // the real Pap — offered for review instead
      "Nutrition Counseling Note",
      "Order for screening mammogram",
      "Radiology: Order for screening mammogram",
      "Screening mammogram declined by patient",
      "Screening mammogram — declined",
      "Pap smear—patient declined HPV co-test",
    ]) {
      expect(
        satisfiedRules(obs({ category: "report", name })),
        `"${name}" must not auto-satisfy`
      ).toEqual([]);
      expect(
        satisfiedRules(obs({ category: "assessment", name })),
        `assessment "${name}" must not auto-satisfy`
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Prose asks: the review candidate
// ---------------------------------------------------------------------------
describe("review candidate derivation", () => {
  it("the real Pap emits exactly one cervical_cancer candidate", () => {
    const candidates = derivePreventiveReviewCandidates([
      report({ id: 7, name: "Cytology, Gyn-PAP Test (AP)" }),
    ]);
    expect(candidates).toEqual([
      {
        recordId: 7,
        ruleKey: "cervical_cancer",
        recordName: "Cytology, Gyn-PAP Test (AP)",
        recordDate: "2024-09-20",
      },
    ]);
    expect(preventiveReviewFactKey(candidates[0])).toBe(
      "preventive-review:7:cervical_cancer"
    );
  });

  it("multiple rule matches are ambiguous and emit nothing", () => {
    // "counseling" is a needle for BOTH depression and anxiety screening — the
    // attempt-1 false-satisfaction fixture. Two matches → no candidate.
    expect(
      derivePreventiveReviewCandidates([
        report({ name: "Nutrition Counseling Note" }),
      ])
    ).toEqual([]);
  });

  it("zero matches emit nothing", () => {
    expect(
      derivePreventiveReviewCandidates([report({ name: "Discharge summary" })])
    ).toEqual([]);
  });

  it("a value-bearing report is a result, not a document to review", () => {
    expect(
      derivePreventiveReviewCandidates([
        report({ name: "Cytology, Gyn-PAP Test (AP)", value: "NILM" }),
      ])
    ).toEqual([]);
  });

  it("only report-category rows are considered", () => {
    expect(
      derivePreventiveReviewCandidates([
        report({ name: "Cytology, Gyn-PAP Test (AP)", category: "assessment" }),
      ])
    ).toEqual([]);
  });

  it("a refusal or order title with one match still only ASKS, never satisfies", () => {
    // The design's point: prose cannot decide in either direction. The person
    // answers — confirm or dismiss.
    const candidates = derivePreventiveReviewCandidates([
      report({ id: 3, name: "Screening mammogram declined by patient" }),
    ]);
    expect(candidates.map((c) => c.ruleKey)).toEqual(["mammography"]);
  });

  it("asks the question in plain words, naming the rule", () => {
    expect(preventiveReviewQuestion("cervical_cancer")).toBe(
      "Does this record show that cervical cancer screening was completed? Confirm the date."
    );
    // Sanity: the copy is derived from the real catalog rule.
    expect(preventiveRuleByKey("cervical_cancer")?.name).toBe(
      "Cervical cancer screening"
    );
  });
});

// ---------------------------------------------------------------------------
// Offer dedupe: identical-content groups ask once (#2919)
// ---------------------------------------------------------------------------
describe("offer dedupe", () => {
  const trip = (ids: number[]): PreventiveReviewCandidate[] =>
    ids.map((id) => ({
      recordId: id,
      ruleKey: "cervical_cancer",
      recordName: "Cytology, Gyn-PAP Test (AP)",
      recordDate: "2024-09-20",
    }));
  const none = () => false;

  it("triplicate identical candidates collapse to ONE offer, newest id carrying it", () => {
    expect(offeredPreventiveReviewCandidates(trip([7, 9, 8]), none)).toEqual(
      trip([9])
    );
  });

  it("a decision on ANY group member answers the whole group", () => {
    // Confirmed/dismissed on the carrier — nothing re-surfaces...
    expect(
      offeredPreventiveReviewCandidates(trip([7, 9, 8]), (id) => id === 9)
    ).toEqual([]);
    // ...and on a NON-carrier sibling (e.g. re-imported under a newer id) too.
    expect(
      offeredPreventiveReviewCandidates(trip([7, 9, 8]), (id) => id === 7)
    ).toEqual([]);
  });

  it("different content stays separate: another date or title is its own offer", () => {
    const earlier = {
      recordId: 3,
      ruleKey: "cervical_cancer",
      recordName: "Cytology, Gyn-PAP Test (AP)",
      recordDate: "2023-03-28",
    };
    const offers = offeredPreventiveReviewCandidates(
      [...trip([7, 8]), earlier],
      none
    );
    expect(offers).toEqual([...trip([8]), earlier]);
  });

  it("normalizes the title for grouping (punctuation/case variants collapse)", () => {
    const variant = {
      recordId: 10,
      ruleKey: "cervical_cancer",
      recordName: "CYTOLOGY GYN PAP TEST (AP)",
      recordDate: "2024-09-20",
    };
    expect(
      offeredPreventiveReviewCandidates([...trip([7]), variant], none)
    ).toEqual([variant]);
  });
});

// ---------------------------------------------------------------------------
// The dashboard fact never enters Now
// ---------------------------------------------------------------------------
describe("dashboard placement", () => {
  it("a review candidate lands in the Everything lane, never Now", () => {
    const candidate = preventiveReviewCandidate(
      { scope: "profile", profileId: 1 },
      { recordId: 7, ruleKey: "cervical_cancer" },
      0
    );
    // Structural bar: no rank reason is true, so nowScore is null at every
    // minute of the day. Removing the bar (any owed/changed reason) would rank
    // it into Now and go red here.
    for (const minutesOfDay of [0, 420, 720, 1200]) {
      const placements = rankDashboardCandidates([candidate], {
        activeProfileId: 1,
        minutesOfDay,
      });
      expect(placements).toHaveLength(1);
      expect(placements[0].lane).toBe("everything");
    }
  });
});
