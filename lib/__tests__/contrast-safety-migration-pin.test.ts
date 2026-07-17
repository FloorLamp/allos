import { describe, expect, it } from "vitest";
import {
  parsePlannedStudy,
  crossCheckContrast,
  contrastSignalKey,
  type PlannedContrastStudy,
} from "@/lib/contrast-safety";

// Behavior-preservation pins for the contrast-safety migration onto the curated-dataset
// framework (issue #860 wave 2, unit 4). This dataset backs the #701/#829 contrast
// safety cross-check; the migration reshaped the JSON into a framework envelope
// (entries = the contrast classes, class-enum identity; the allergy/renal gate tables
// in meta) and re-sourced the detector through it. The cross-check OUTPUT must be
// byte-identical. This file pins the exact outcomes for representative inputs —
// INCLUDING the #829 allergy false-negative fixes (brand-agent allergens and
// order-insensitive multi-word keyword matching) whose regression is the whole reason
// #829 exists. Synthetic values only, no PHI.

function iodinatedCT(
  overrides: Partial<PlannedContrastStudy> = {}
): PlannedContrastStudy {
  return {
    source: "careplan",
    sourceId: 1,
    contrastClass: "iodinated",
    label: "CT abdomen with contrast",
    date: null,
    ...overrides,
  };
}

function gadoliniumMRI(
  overrides: Partial<PlannedContrastStudy> = {}
): PlannedContrastStudy {
  return {
    source: "careplan",
    sourceId: 2,
    contrastClass: "gadolinium",
    label: "MRI brain with gadolinium",
    date: null,
    ...overrides,
  };
}

describe("contrast text parsing is behavior-preserving (class-enum resolution)", () => {
  it("resolves a study's contrast class from text/agent/modality, and refuses non-contrast", () => {
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 1,
        text: "CT abdomen with contrast",
        date: null,
      })?.contrastClass
    ).toBe("iodinated");
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 2,
        text: "MRI brain with gadolinium",
        date: null,
      })?.contrastClass
    ).toBe("gadolinium");
    // A named brand agent alone pins the class (Omnipaque → iodinated).
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 3,
        text: "CT with Omnipaque",
        date: null,
      })?.contrastClass
    ).toBe("iodinated");
    // "without contrast" never triggers.
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 4,
        text: "CT abdomen without contrast",
        date: null,
      })
    ).toBeNull();
  });
});

describe("contrast allergy gate is behavior-preserving", () => {
  it("flags a plain iodinated-contrast allergy with the exact note + dedupeKey", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Iodine"],
      conditions: [],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("allergy");
    expect(hits[0].note).toBe(
      "You have an iodinated-contrast allergy on file — confirm premedication with your provider."
    );
    expect(hits[0].dedupeKey).toBe(
      contrastSignalKey("careplan", 1, "allergy", "iodinated")
    );
  });

  it("flags a gadolinium-contrast allergy against an MRI study", () => {
    const hits = crossCheckContrast([gadoliniumMRI()], {
      allergens: ["gadolinium"],
      conditions: [],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("allergy");
    expect(hits[0].contrastClass).toBe("gadolinium");
  });

  // #829 Finding 1: a brand/generic AGENT name recorded as the allergy must screen too.
  it.each([["Omnipaque"], ["Optiray"], ["Allergic to Isovue"], ["Ultravist"]])(
    "flags the brand-agent allergen %s against an iodinated study (#829 Finding 1)",
    (allergen) => {
      const hits = crossCheckContrast([iodinatedCT()], {
        allergens: [allergen],
        conditions: [],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].gate).toBe("allergy");
    }
  );

  it("does NOT cross an iodinated-agent allergen onto a gadolinium study (class-scoped)", () => {
    const hits = crossCheckContrast([gadoliniumMRI()], {
      allergens: ["Omnipaque"],
      conditions: [],
    });
    expect(hits).toHaveLength(0);
  });

  // #829 Finding 2: multi-word keywords match order/adjacency-insensitively.
  it.each([["Contrast, IV"], ["Dye (Contrast)"], ["IV Dye"]])(
    "flags the reordered multi-word allergen %s against an iodinated study (#829 Finding 2)",
    (allergen) => {
      const hits = crossCheckContrast([iodinatedCT()], {
        allergens: [allergen],
        conditions: [],
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].gate).toBe("allergy");
    }
  );

  // #829 precision guard: a shared single token must NOT fire a two-token keyword.
  it("never flags an unrelated allergen that shares only one keyword token (#829 precision)", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Yellow dye 5", "IV antibiotics", "Shellfish"],
      conditions: [],
    });
    expect(hits).toHaveLength(0);
  });
});

describe("contrast renal gate is behavior-preserving", () => {
  it("flags any CKD against an iodinated study (CIN gate)", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: [],
      conditions: ["Chronic kidney disease stage 3"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("renal");
    expect(hits[0].note).toContain("nephropathy");
  });

  it("flags only ADVANCED CKD against a gadolinium study (NSF gate)", () => {
    // Advanced → hit.
    const advanced = crossCheckContrast([gadoliniumMRI()], {
      allergens: [],
      conditions: ["ESRD on dialysis"],
    });
    expect(advanced).toHaveLength(1);
    expect(advanced[0].gate).toBe("renal");
    expect(advanced[0].note).toContain("NSF");
    // Early-stage CKD → no gadolinium renal hit.
    const early = crossCheckContrast([gadoliniumMRI()], {
      allergens: [],
      conditions: ["Chronic kidney disease stage 2"],
    });
    expect(early).toHaveLength(0);
  });

  it("returns nothing when neither allergy nor renal state is present", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Penicillin"],
      conditions: ["Hypertension"],
    });
    expect(hits).toHaveLength(0);
  });
});
