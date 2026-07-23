import { describe, it, expect } from "vitest";
import {
  classLabel,
  encounterKind,
  encounterTypeDisplay,
  ENCOUNTER_CLASS_LABELS,
  ENCOUNTER_KIND_LABELS,
  ENCOUNTER_KIND_ORDER,
  type EncounterKind,
} from "../encounter-kind";

describe("classLabel", () => {
  it("relabels a known ActEncounterCode class", () => {
    expect(classLabel("AMB")).toBe("Ambulatory");
    expect(classLabel("EMER")).toBe("Emergency");
    expect(classLabel("IMP")).toBe("Inpatient");
    expect(classLabel("VR")).toBe("Virtual");
  });

  it("is case-insensitive on the code", () => {
    expect(classLabel("amb")).toBe("Ambulatory");
  });

  it("falls back to the upper-cased raw code for an uncatalogued class", () => {
    expect(classLabel("xyz")).toBe("XYZ");
  });

  it("returns null when there is no class", () => {
    expect(classLabel(null)).toBeNull();
    expect(classLabel(undefined)).toBeNull();
    expect(classLabel("  ")).toBeNull();
  });
});

describe("encounterTypeDisplay", () => {
  it("prefers the source free-text type", () => {
    expect(encounterTypeDisplay("Office Visit", "AMB")).toBe("Office Visit");
  });

  it("falls back to the class label when type is blank (better than bare 'Visit')", () => {
    expect(encounterTypeDisplay(null, "AMB")).toBe("Ambulatory");
    expect(encounterTypeDisplay("  ", "EMER")).toBe("Emergency");
  });

  it("falls back to 'Visit' when neither type nor class is present", () => {
    expect(encounterTypeDisplay(null, null)).toBe("Visit");
    expect(encounterTypeDisplay(undefined, undefined)).toBe("Visit");
  });
});

describe("encounterKind — class-driven", () => {
  it("maps each strong setting class to its kind", () => {
    expect(encounterKind({ classCode: "AMB" })).toBe("ambulatory");
    expect(encounterKind({ classCode: "EMER" })).toBe("emergency");
    expect(encounterKind({ classCode: "IMP" })).toBe("inpatient");
    expect(encounterKind({ classCode: "OBSENC" })).toBe("observation");
    expect(encounterKind({ classCode: "VR" })).toBe("virtual");
    expect(encounterKind({ classCode: "HH" })).toBe("home_health");
  });

  it("folds inpatient subtypes into inpatient", () => {
    expect(encounterKind({ classCode: "ACUTE" })).toBe("inpatient");
    expect(encounterKind({ classCode: "NONAC" })).toBe("inpatient");
    expect(encounterKind({ classCode: "SS" })).toBe("inpatient");
  });

  it("is case-insensitive on the class", () => {
    expect(encounterKind({ classCode: "emer" })).toBe("emergency");
  });
});

describe("encounterKind — exclusion discipline (#482)", () => {
  it("keeps observation APART from inpatient (distinct admission status)", () => {
    expect(encounterKind({ classCode: "OBSENC" })).not.toBe("inpatient");
    expect(encounterKind({ classCode: "OBSENC" })).toBe("observation");
  });

  it("keeps virtual APART from ambulatory (telehealth vs in-person)", () => {
    expect(encounterKind({ classCode: "VR" })).not.toBe("ambulatory");
  });

  it("never folds emergency into ambulatory", () => {
    expect(encounterKind({ classCode: "EMER" })).not.toBe("ambulatory");
  });

  it("a strong setting class dominates a stray preventive code", () => {
    // An ED visit carrying a preventive-medicine code is still an emergency.
    expect(encounterKind({ classCode: "EMER", code: "99396" })).toBe(
      "emergency"
    );
    expect(encounterKind({ classCode: "IMP", code: "99385" })).toBe(
      "inpatient"
    );
  });

  it("a diagnostic office-visit E/M is ambulatory, NOT preventive", () => {
    // 99213/99214 are problem-oriented E/M, not preventive-medicine codes.
    expect(encounterKind({ classCode: "AMB", code: "99213" })).toBe(
      "ambulatory"
    );
    expect(encounterKind({ classCode: "AMB", code: "99214" })).toBe(
      "ambulatory"
    );
  });
});

describe("encounterKind — preventive refinement (class + type code, #1233)", () => {
  it("an ambulatory visit with a preventive-medicine CPT is preventive", () => {
    for (const c of ["99381", "99387", "99391", "99397"]) {
      expect(encounterKind({ classCode: "AMB", code: c })).toBe("preventive");
    }
  });

  it("Medicare annual-wellness HCPCS codes are preventive", () => {
    for (const c of ["G0402", "G0438", "G0439"]) {
      expect(encounterKind({ classCode: "AMB", code: c })).toBe("preventive");
    }
  });

  it("a preventive code with no class still yields preventive", () => {
    expect(encounterKind({ code: "99396" })).toBe("preventive");
  });

  it("does not treat an adjacent non-preventive numeric code as preventive", () => {
    expect(encounterKind({ classCode: "AMB", code: "99388" })).toBe(
      "ambulatory"
    );
    expect(encounterKind({ code: "99215" })).toBe("other");
  });
});

describe("encounterKind — conservative type-text fallback (no class/code)", () => {
  it("classifies from unambiguous whole-word keywords", () => {
    expect(encounterKind({ type: "Emergency Department Visit" })).toBe(
      "emergency"
    );
    expect(encounterKind({ type: "ED visit" })).toBe("emergency");
    expect(encounterKind({ type: "Inpatient stay" })).toBe("inpatient");
    expect(encounterKind({ type: "Telehealth visit" })).toBe("virtual");
    expect(encounterKind({ type: "Video visit" })).toBe("virtual");
    expect(encounterKind({ type: "Home health visit" })).toBe("home_health");
    expect(encounterKind({ type: "Annual Wellness Visit" })).toBe("preventive");
    expect(encounterKind({ type: "Office Visit" })).toBe("ambulatory");
    expect(encounterKind({ type: "Follow-up" })).toBe("ambulatory");
  });

  it("whole-word discipline: 'physical therapy' is NOT a preventive physical", () => {
    expect(encounterKind({ type: "Physical Therapy" })).not.toBe("preventive");
    expect(encounterKind({ type: "Physical Therapy" })).toBe("other");
  });

  it("a class always wins over the type text", () => {
    // The class is the canonical axis; a mislabeled type never overrides it.
    expect(encounterKind({ classCode: "EMER", type: "Office Visit" })).toBe(
      "emergency"
    );
  });
});

describe("encounterKind — defined fate for unmapped input", () => {
  it("unknown class with no code/text is 'other'", () => {
    expect(encounterKind({ classCode: "FLD" })).toBe("other");
    expect(encounterKind({ classCode: "ZZZ" })).toBe("other");
  });

  it("wholly empty input is 'other'", () => {
    expect(encounterKind({})).toBe("other");
    expect(encounterKind({ classCode: null, code: null, type: null })).toBe(
      "other"
    );
  });
});

describe("kind label/order registries stay in sync", () => {
  it("every kind in the order has a label and vice versa", () => {
    const labelKeys = Object.keys(ENCOUNTER_KIND_LABELS) as EncounterKind[];
    expect([...ENCOUNTER_KIND_ORDER].sort()).toEqual([...labelKeys].sort());
  });

  it("every class label code is upper-case (matches the case-insensitive lookup)", () => {
    for (const k of Object.keys(ENCOUNTER_CLASS_LABELS)) {
      expect(k).toBe(k.toUpperCase());
    }
  });
});
