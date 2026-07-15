import { describe, expect, it } from "vitest";
import {
  parsePlannedStudy,
  crossCheckContrast,
  contrastTitle,
  contrastDetail,
  contrastSignalKey,
  type PlannedContrastStudy,
} from "@/lib/contrast-safety";

// Pure contrast-safety cross-check (issue #701): planned contrast study text-parse +
// class detection + the allergy/renal gate matching + the required framing. No DB.

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

describe("parsePlannedStudy — contrast intent + class", () => {
  it("parses a CT-with-contrast care-plan item as iodinated", () => {
    const s = parsePlannedStudy({
      source: "careplan",
      sourceId: 7,
      text: "CT abdomen and pelvis with contrast",
      date: "2026-08-01",
    });
    expect(s).not.toBeNull();
    expect(s!.contrastClass).toBe("iodinated");
    expect(s!.sourceId).toBe(7);
  });

  it("parses an MRI-with-gadolinium appointment as gadolinium", () => {
    const s = parsePlannedStudy({
      source: "appointment",
      sourceId: 3,
      text: "MRI brain with gadolinium",
      date: "2026-09-10",
    });
    expect(s!.contrastClass).toBe("gadolinium");
  });

  it("recognizes a named agent as contrast intent (no 'with contrast' phrase)", () => {
    const s = parsePlannedStudy({
      source: "appointment",
      sourceId: 4,
      text: "MRI liver Eovist protocol",
      date: null,
    });
    expect(s!.contrastClass).toBe("gadolinium");
  });

  it("recognizes 'contrast-enhanced' phrasing", () => {
    const s = parsePlannedStudy({
      source: "careplan",
      sourceId: 5,
      text: "Contrast-enhanced CT chest",
      date: null,
    });
    expect(s!.contrastClass).toBe("iodinated");
  });

  it("does NOT trigger on a without-contrast study", () => {
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 6,
        text: "CT chest without contrast",
        date: null,
      })
    ).toBeNull();
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 6,
        text: "Non-contrast CT head",
        date: null,
      })
    ).toBeNull();
  });

  it("does NOT trigger on a non-imaging or contrast-free plan item", () => {
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 8,
        text: "Colonoscopy screening",
        date: null,
      })
    ).toBeNull();
    expect(
      parsePlannedStudy({
        source: "careplan",
        sourceId: 8,
        text: "CT chest low-dose screening",
        date: null,
      })
    ).toBeNull();
  });

  it("honors a structured imaging contrast flag + modality (no text phrase needed)", () => {
    const s = parsePlannedStudy({
      source: "imaging",
      sourceId: 9,
      text: "MRI abdomen",
      label: "MRI abdomen with contrast",
      date: "2026-12-01",
      modality: "mri",
      contrastFlag: true,
    });
    expect(s!.contrastClass).toBe("gadolinium");
    expect(s!.label).toBe("MRI abdomen with contrast");
  });
});

describe("crossCheckContrast — allergy gates", () => {
  it("flags an iodinated-contrast allergy vs a planned iodinated study", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Iodinated contrast media"],
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

  it("flags a plain 'iodine' allergy (the issue's explicit gate)", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Iodine"],
      conditions: [],
    });
    expect(hits.some((h) => h.gate === "allergy")).toBe(true);
  });

  it("flags a gadolinium allergy vs a planned gadolinium study", () => {
    const study = iodinatedCT({
      contrastClass: "gadolinium",
      label: "MRI with gadolinium",
      source: "appointment",
      sourceId: 2,
    });
    const hits = crossCheckContrast([study], {
      allergens: ["Gadolinium contrast"],
      conditions: [],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].note).toContain("gadolinium-contrast allergy");
  });

  it("does NOT cross a gadolinium allergy onto an iodinated study", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Gadolinium"],
      conditions: [],
    });
    expect(hits).toEqual([]);
  });

  it("no allergy / no condition → nothing", () => {
    expect(
      crossCheckContrast([iodinatedCT()], {
        allergens: ["Penicillin", "Peanuts"],
        conditions: ["Hypertension"],
      })
    ).toEqual([]);
  });
});

describe("crossCheckContrast — renal gates", () => {
  it("flags CKD vs a planned iodinated study (contrast nephropathy)", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: [],
      conditions: ["Chronic kidney disease stage 3"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("renal");
    expect(hits[0].note).toBe(
      "CKD on file — discuss contrast nephropathy risk / hydration with your provider."
    );
  });

  it("does NOT flag ordinary (non-advanced) CKD vs a gadolinium study", () => {
    const study = iodinatedCT({
      contrastClass: "gadolinium",
      label: "MRI with gadolinium",
    });
    const hits = crossCheckContrast([study], {
      allergens: [],
      conditions: ["Chronic kidney disease stage 3"],
    });
    expect(hits).toEqual([]);
  });

  it("flags ADVANCED CKD (dialysis/ESRD/stage 5) vs a gadolinium study (NSF)", () => {
    const study = iodinatedCT({
      contrastClass: "gadolinium",
      label: "MRI with gadolinium",
    });
    const hits = crossCheckContrast([study], {
      allergens: [],
      conditions: ["ESRD on dialysis"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].note).toContain("NSF risk");
  });

  it("both an allergy AND a renal gate can fire on one study", () => {
    const hits = crossCheckContrast([iodinatedCT()], {
      allergens: ["Iodinated contrast"],
      conditions: ["CKD stage 4"],
    });
    expect(hits.map((h) => h.gate).sort()).toEqual(["allergy", "renal"]);
  });
});

describe("formatting + one-computation framing", () => {
  it("title names the class + study; detail carries the guardrail + citation", () => {
    const [hit] = crossCheckContrast([iodinatedCT()], {
      allergens: ["Iodinated contrast"],
      conditions: [],
    });
    expect(contrastTitle(hit)).toBe(
      "Iodinated contrast — CT abdomen with contrast"
    );
    const detail = contrastDetail(hit);
    expect(detail).toContain(hit.note);
    expect(detail).toContain(
      "it does not advise for or against the study, and the absence of a flag is not clearance"
    );
    expect(detail).toContain("Source: ACR Manual on Contrast Media.");
  });
});
