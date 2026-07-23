import { describe, it, expect } from "vitest";
import {
  detectDataQualityGaps,
  householdDataQualityLine,
  dataQualityDedupeKey,
  DATA_QUALITY_PREFIX,
  REPRODUCTIVE_STATUS_BAND_MIN_AGE,
  PEDIATRIC_HEIGHT_MAX_AGE,
  type DataQualityInputs,
} from "../data-quality";

// Pure detector tier (#1045). Each detector over set/unset/edge fixtures, the leverage
// ranking, and the BOUNDARY invariant: a structurally-complete profile yields NO gaps
// regardless of logging behavior. No DB, no network.

// A structurally-COMPLETE adult profile: every gap detector must stay silent.
const COMPLETE_ADULT: DataQualityInputs = {
  age: 40,
  sexKnown: true,
  sex: "male",
  reproductiveStatusKnown: false, // male → reproductive gate never fires
  heightKnown: false, // adult → pediatric-height gate never fires
  smokingKnown: true,
  medsMissingRxcui: 0,
  medMissingRxcuiId: null,
  prescribersNeedingLink: 0,
  phenoAgePresentCount: 9,
  phenoAgeMissingCount: 0,
  phenoAgeMissingPrimary: null,
  failedExtractions: 0,
  riskAttributesReviewed: true,
};

function keysOf(inputs: DataQualityInputs): string[] {
  return detectDataQualityGaps(inputs).map((g) => g.key);
}

describe("detectDataQualityGaps — the boundary invariant", () => {
  it("fires NOTHING on a structurally-complete adult profile", () => {
    expect(detectDataQualityGaps(COMPLETE_ADULT)).toEqual([]);
  });

  it("stays empty regardless of logging-behavior variation (structural only)", () => {
    // A complete-structure profile with a partial PhenoAge panel is STILL not nagged
    // here as long as the structural fields are set — except the PhenoAge partial,
    // which is itself structural. Prove the boundary excludes non-structural churn:
    // present=0 (no labs logged) is NOT a gap, and neither is a full panel.
    expect(
      detectDataQualityGaps({
        ...COMPLETE_ADULT,
        phenoAgePresentCount: 0,
        phenoAgeMissingCount: 9,
        phenoAgeMissingPrimary: "Albumin",
      })
    ).toEqual([]);
  });
});

describe("birthdate detector — fires on unknown age only", () => {
  it("fires when age is null (no birthdate and no stored age)", () => {
    expect(keysOf({ ...COMPLETE_ADULT, age: null })).toContain("birthdate");
  });
  it("does NOT fire when a stored age is known (age set)", () => {
    expect(keysOf({ ...COMPLETE_ADULT, age: 30 })).not.toContain("birthdate");
  });
  it("has the highest leverage (ranks first)", () => {
    const gaps = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      age: null,
      sexKnown: false,
    });
    expect(gaps[0].key).toBe("birthdate");
    expect(gaps[0].leverage).toBe(6);
  });
});

describe("sex detector", () => {
  it("fires when sex unset", () => {
    expect(keysOf({ ...COMPLETE_ADULT, sexKnown: false, sex: null })).toContain(
      "sex"
    );
  });
  it("does not fire when sex known", () => {
    expect(keysOf(COMPLETE_ADULT)).not.toContain("sex");
  });
});

describe("reproductive-status detector — female + age band only", () => {
  const femaleInBand: DataQualityInputs = {
    ...COMPLETE_ADULT,
    sex: "female",
    age: REPRODUCTIVE_STATUS_BAND_MIN_AGE,
    reproductiveStatusKnown: false,
  };
  it("fires for a female in the perimenopausal-and-up band with no status", () => {
    expect(keysOf(femaleInBand)).toContain("reproductive-status");
  });
  it("does NOT fire for a female BELOW the band", () => {
    expect(
      keysOf({ ...femaleInBand, age: REPRODUCTIVE_STATUS_BAND_MIN_AGE - 1 })
    ).not.toContain("reproductive-status");
  });
  it("does NOT fire for a male in the band (female physiology only)", () => {
    expect(keysOf({ ...femaleInBand, sex: "male" })).not.toContain(
      "reproductive-status"
    );
  });
  it("does NOT fire once a status is recorded", () => {
    expect(
      keysOf({ ...femaleInBand, reproductiveStatusKnown: true })
    ).not.toContain("reproductive-status");
  });
  it("does NOT fire for an unknown age", () => {
    expect(keysOf({ ...femaleInBand, age: null })).not.toContain(
      "reproductive-status"
    );
  });
});

describe("pediatric-height detector — pediatric BP-regime age only", () => {
  const childNoHeight: DataQualityInputs = {
    ...COMPLETE_ADULT,
    age: PEDIATRIC_HEIGHT_MAX_AGE - 1,
    heightKnown: false,
    // Adult-gated detectors must stay off for a child so we isolate the height gap.
    smokingKnown: true,
    riskAttributesReviewed: true,
    phenoAgePresentCount: 0,
    phenoAgeMissingCount: 9,
  };
  it("fires for a child with no height on file", () => {
    expect(keysOf(childNoHeight)).toContain("pediatric-height");
  });
  it("does not fire once a height exists", () => {
    expect(keysOf({ ...childNoHeight, heightKnown: true })).not.toContain(
      "pediatric-height"
    );
  });
  it("does not fire at/above the pediatric BP ceiling", () => {
    expect(
      keysOf({ ...childNoHeight, age: PEDIATRIC_HEIGHT_MAX_AGE })
    ).not.toContain("pediatric-height");
  });
  it("does not fire for an unknown age (birthdate gap covers it)", () => {
    expect(keysOf({ ...childNoHeight, age: null })).not.toContain(
      "pediatric-height"
    );
  });
});

describe("smoking-status detector — adult only", () => {
  it("fires for an adult with smoking unknown", () => {
    expect(keysOf({ ...COMPLETE_ADULT, smokingKnown: false })).toContain(
      "smoking-status"
    );
  });
  it("does not fire for a child (consumer can't apply)", () => {
    expect(
      keysOf({ ...COMPLETE_ADULT, age: 8, smokingKnown: false })
    ).not.toContain("smoking-status");
  });
  it("does not fire for an unknown age", () => {
    expect(
      keysOf({ ...COMPLETE_ADULT, age: null, smokingKnown: false })
    ).not.toContain("smoking-status");
  });
});

describe("med-rxcui detector", () => {
  it("fires when active meds lack a confirmed RxCUI, leverage 4", () => {
    const gaps = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      medsMissingRxcui: 2,
    });
    const g = gaps.find((x) => x.key === "med-rxcui");
    expect(g).toBeTruthy();
    expect(g!.leverage).toBe(4);
    expect(g!.whyLine).toContain("2");
  });
  it("does not fire when every med has a code", () => {
    expect(keysOf({ ...COMPLETE_ADULT, medsMissingRxcui: 0 })).not.toContain(
      "med-rxcui"
    );
  });
});

describe("phenoage-inputs detector — partial panel, adult only", () => {
  it("fires for an adult with SOME but not all inputs", () => {
    expect(
      keysOf({
        ...COMPLETE_ADULT,
        phenoAgePresentCount: 5,
        phenoAgeMissingCount: 4,
      })
    ).toContain("phenoage-inputs");
  });
  it("does not fire with zero inputs present (labs-empty, not nagged)", () => {
    expect(
      keysOf({
        ...COMPLETE_ADULT,
        phenoAgePresentCount: 0,
        phenoAgeMissingCount: 9,
      })
    ).not.toContain("phenoage-inputs");
  });
  it("does not fire when the panel is complete", () => {
    expect(keysOf(COMPLETE_ADULT)).not.toContain("phenoage-inputs");
  });
  it("does not fire for a child (adult model)", () => {
    expect(
      keysOf({
        ...COMPLETE_ADULT,
        age: 8,
        phenoAgePresentCount: 5,
        phenoAgeMissingCount: 4,
      })
    ).not.toContain("phenoage-inputs");
  });
});

describe("failed-extractions detector", () => {
  it("fires with a count and pluralizes correctly", () => {
    const one = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      failedExtractions: 1,
    }).find((g) => g.key === "failed-extractions");
    expect(one?.label).toContain("1 failed document");
    const many = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      failedExtractions: 3,
    }).find((g) => g.key === "failed-extractions");
    expect(many?.label).toContain("3 failed documents");
  });
});

describe("risk-attributes detector — adult, unreviewed", () => {
  it("fires for an adult who never reviewed risk factors", () => {
    expect(
      keysOf({ ...COMPLETE_ADULT, riskAttributesReviewed: false })
    ).toContain("risk-attributes");
  });
  it("does not fire once reviewed", () => {
    expect(keysOf(COMPLETE_ADULT)).not.toContain("risk-attributes");
  });
  it("does not fire for a child", () => {
    expect(
      keysOf({ ...COMPLETE_ADULT, age: 8, riskAttributesReviewed: false })
    ).not.toContain("risk-attributes");
  });
});

describe("leverage ranking is stable and deterministic", () => {
  it("ranks by leverage descending (birthdate > med-rxcui > sex > smoking)", () => {
    const gaps = detectDataQualityGaps({
      age: null, // birthdate (6)
      sexKnown: false, // sex (3)
      sex: null,
      reproductiveStatusKnown: false,
      heightKnown: false,
      smokingKnown: false, // smoking gated on adult → age null suppresses it
      medsMissingRxcui: 1, // med-rxcui (4)
      medMissingRxcuiId: 42,
      prescribersNeedingLink: 0,
      phenoAgePresentCount: 0,
      phenoAgeMissingCount: 9,
      phenoAgeMissingPrimary: "Albumin",
      failedExtractions: 1, // failed (1)
      riskAttributesReviewed: false, // risk gated on adult → suppressed (age null)
    });
    const order = gaps.map((g) => g.key);
    // Age is null: adult-gated smoking/risk/phenoage stay silent, so the visible
    // ranking is birthdate(6) > med-rxcui(4) > sex(3) > failed-extractions(1).
    expect(order).toEqual([
      "birthdate",
      "med-rxcui",
      "sex",
      "failed-extractions",
    ]);
    // Leverage is monotonically non-increasing.
    const levs = gaps.map((g) => g.leverage);
    expect([...levs]).toEqual([...levs].sort((a, b) => b - a));
  });

  it("every gap's dedupeKey carries the registered prefix", () => {
    const gaps = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      medsMissingRxcui: 1,
      failedExtractions: 1,
      riskAttributesReviewed: false,
      smokingKnown: false,
    });
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(dataQualityDedupeKey(g.key).startsWith(DATA_QUALITY_PREFIX)).toBe(
        true
      );
    }
  });
});

describe("ctaHref precision — every gap deep-links the concrete form (#1146)", () => {
  function gapFor(inputs: DataQualityInputs, key: string) {
    const g = detectDataQualityGaps(inputs).find((x) => x.key === key);
    expect(g, `expected gap ${key} to fire`).toBeTruthy();
    return g!;
  }

  it("phenoage-inputs prefills the biomarker add form with the first missing analyte", () => {
    const g = gapFor(
      {
        ...COMPLETE_ADULT,
        phenoAgePresentCount: 5,
        phenoAgeMissingCount: 4,
        phenoAgeMissingPrimary: "hs-CRP",
      },
      "phenoage-inputs"
    );
    expect(g.ctaHref).toBe("/results/biomarkers?new=1&name=hs-CRP");
  });

  it("phenoage-inputs falls back to the unprefilled add form when no primary is known", () => {
    const g = gapFor(
      {
        ...COMPLETE_ADULT,
        phenoAgePresentCount: 5,
        phenoAgeMissingCount: 4,
        phenoAgeMissingPrimary: null,
      },
      "phenoage-inputs"
    );
    expect(g.ctaHref).toBe("/results/biomarkers?new=1");
  });

  it("risk-attributes targets the risk-factors form, not the records landing page", () => {
    const g = gapFor(
      { ...COMPLETE_ADULT, riskAttributesReviewed: false },
      "risk-attributes"
    );
    expect(g.ctaHref).toBe("/records/care/overview#risk-factors");
  });

  it("smoking-status targets the smoking-history form, not the records landing page", () => {
    const g = gapFor(
      { ...COMPLETE_ADULT, smokingKnown: false },
      "smoking-status"
    );
    expect(g.ctaHref).toBe("/records/care/overview#smoking-history");
  });

  it("med-rxcui with ONE unconfirmed med deep-links that med's edit form", () => {
    const g = gapFor(
      { ...COMPLETE_ADULT, medsMissingRxcui: 1, medMissingRxcuiId: 42 },
      "med-rxcui"
    );
    expect(g.ctaHref).toBe("/medications/42?action=edit");
  });

  it("med-rxcui with SEVERAL unconfirmed meds links the list filtered to them", () => {
    const g = gapFor(
      { ...COMPLETE_ADULT, medsMissingRxcui: 3, medMissingRxcuiId: null },
      "med-rxcui"
    );
    expect(g.ctaHref).toBe("/medications?filter=needs-rxcui");
  });

  it("med-rxcui without a sole id falls back to the filtered list even at N=1", () => {
    const g = gapFor(
      { ...COMPLETE_ADULT, medsMissingRxcui: 1, medMissingRxcuiId: null },
      "med-rxcui"
    );
    expect(g.ctaHref).toBe("/medications?filter=needs-rxcui");
  });

  it("pediatric-height targets the growth quick-add, focused on height", () => {
    const g = gapFor(
      {
        ...COMPLETE_ADULT,
        age: PEDIATRIC_HEIGHT_MAX_AGE - 1,
        heightKnown: false,
      },
      "pediatric-height"
    );
    expect(g.ctaHref).toBe("/trends?tab=body&focus=height");
  });

  it("GUARD: no gap's ctaHref uses a pre-#1079 base or a bare browse page", () => {
    // Fire the maximal gap set across two age regimes and check every CTA base.
    const allGaps = [
      ...detectDataQualityGaps({
        age: null,
        sexKnown: false,
        sex: null,
        reproductiveStatusKnown: false,
        heightKnown: false,
        smokingKnown: false,
        medsMissingRxcui: 2,
        medMissingRxcuiId: null,
        prescribersNeedingLink: 1,
        phenoAgePresentCount: 3,
        phenoAgeMissingCount: 6,
        phenoAgeMissingPrimary: "Albumin",
        failedExtractions: 1,
        riskAttributesReviewed: false,
      }),
      ...detectDataQualityGaps({
        ...COMPLETE_ADULT,
        sex: "female",
        age: REPRODUCTIVE_STATUS_BAND_MIN_AGE,
        reproductiveStatusKnown: false,
        smokingKnown: false,
        riskAttributesReviewed: false,
        medsMissingRxcui: 1,
        medMissingRxcuiId: 7,
        phenoAgePresentCount: 1,
        phenoAgeMissingCount: 8,
        phenoAgeMissingPrimary: "Creatinine",
      }),
      ...detectDataQualityGaps({
        ...COMPLETE_ADULT,
        age: PEDIATRIC_HEIGHT_MAX_AGE - 1,
        heightKnown: false,
      }),
    ];
    expect(allGaps.length).toBeGreaterThanOrEqual(10);
    // Post-#1079 route discipline: the redirect-surviving legacy literals would
    // still typecheck, so pin the exact allowed bases here (the #1083 trap).
    const ALLOWED_BASES = [
      "/settings/profile",
      "/results/biomarkers",
      "/records/care/overview",
      "/medications",
      /^\/medications\/\d+$/,
      "/trends",
      "/data",
    ];
    for (const g of allGaps) {
      const base = g.ctaHref.split(/[?#]/)[0];
      const ok = ALLOWED_BASES.some((b) =>
        typeof b === "string" ? b === base : b.test(base)
      );
      expect(ok, `unexpected ctaHref base for ${g.key}: ${g.ctaHref}`).toBe(
        true
      );
      // Never the pre-#1079 hash-section form or a bare browse page.
      // (prescriber-link is the one deliberate list-level target: its accept
      // affordance has no dedicated form surface yet — #1051.)
      expect(g.ctaHref.startsWith("/results#")).toBe(false);
      expect(g.ctaHref).not.toBe("/records");
      if (g.key !== "prescriber-link") {
        expect(g.ctaHref).not.toBe("/medications");
      }
    }
  });
});

describe("householdDataQualityLine", () => {
  it("returns null with no gaps", () => {
    expect(householdDataQualityLine([])).toBeNull();
  });
  it("returns the single gap's label when there's exactly one", () => {
    const gaps = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      failedExtractions: 1,
    });
    expect(gaps).toHaveLength(1);
    expect(householdDataQualityLine(gaps)).toBe(gaps[0].label);
  });
  it("summarizes multiple gaps with a count and terse nouns", () => {
    const gaps = detectDataQualityGaps({
      ...COMPLETE_ADULT,
      age: null,
      sexKnown: false,
      sex: null,
    });
    const line = householdDataQualityLine(gaps);
    expect(line).toContain(`${gaps.length} data gaps`);
    expect(line).toContain("birthdate");
    expect(line).toContain("sex");
  });
});
